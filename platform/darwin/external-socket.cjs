"use strict";

const { randomUUID } = require("node:crypto");
const net = require("node:net");
const { PROTOCOL_VERSION } = require("../../core/channels.cjs");
const { parseBridgeEvent } = require("../../internal/rum-line-protocol.cjs");
const { integer, reportError, requiredString } = require("../../internal/options.cjs");
const { isAllowedHost, parseBridgeConfiguration } = require("./managed.cjs");

const MAXIMUM_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_PENDING_BYTES = 4 * 1024 * 1024;
const MAXIMUM_PENDING_REQUESTS = 4096;
const FULL_SNAPSHOT_COMMAND = "takeSubsequentFullSnapshot";
const FULL_SNAPSHOT_SCRIPT = "window.DATAFLUX_RUM?.takeSubsequentFullSnapshot()";
const MIXED_MODE_ENVIRONMENT = Object.freeze({
  socketPath: "GUANCE_ELECTRON_SOCKET_PATH",
  authenticationToken: "GUANCE_ELECTRON_AUTH_TOKEN",
  protocolVersion: "GUANCE_ELECTRON_PROTOCOL_VERSION",
});

function resolveCredentials({
  socketPath,
  authenticationToken,
  protocolVersion,
  environment = process.env,
} = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("native.environment must be an object.");
  }
  const resolvedProtocol = protocolVersion ?? environment[MIXED_MODE_ENVIRONMENT.protocolVersion];
  if (resolvedProtocol !== undefined && String(resolvedProtocol) !== String(PROTOCOL_VERSION)) {
    throw new Error(`Unsupported Native Electron Bridge protocol ${resolvedProtocol}.`);
  }
  return Object.freeze({
    socketPath: requiredString(
      socketPath ?? environment[MIXED_MODE_ENVIRONMENT.socketPath],
      "Native Electron Bridge socket path",
    ),
    authenticationToken: requiredString(
      authenticationToken ?? environment[MIXED_MODE_ENVIRONMENT.authenticationToken],
      "Native Electron Bridge authentication token",
    ),
  });
}

function createExternalSocketAdapter(options = {}) {
  const timeoutMs = integer(
    options.connectTimeoutMs ?? options.timeoutMs,
    5_000,
    1,
    60_000,
    "native.connectTimeoutMs",
  );
  const connectionID = randomUUID();
  let socket;
  let input = Buffer.alloc(0);
  let bridgeConfiguration;
  let capabilities;
  let started = false;
  let starting;
  let stopping = false;
  let stopped;
  let transportFailure;
  let backpressured = false;
  let nextSequence = 1;
  let commandListener;
  const registrations = new Map();
  const pendingRequests = new Map();

  const failTransport = (error) => {
    if (stopping || transportFailure) return;
    transportFailure = error instanceof Error
      ? error
      : new Error("The Native Electron Bridge failed.");
    reportError(options.onError, transportFailure);
  };
  const writable = () => Boolean(
    started && !stopping && !transportFailure && socket?.writable && !socket.destroyed,
  );
  const writeEnvelope = (message) => {
    if (stopping || transportFailure || !socket?.writable || socket.destroyed) return false;
    let data;
    try {
      data = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    } catch {
      return false;
    }
    if (data.length > MAXIMUM_ENVELOPE_BYTES ||
        socket.writableLength + data.length > MAXIMUM_PENDING_BYTES) {
      const error = new Error("The Native Electron Bridge pending payload limit was exceeded.");
      failTransport(error);
      socket.destroy();
      return false;
    }
    try {
      if (!socket.write(data)) backpressured = true;
      return true;
    } catch (error) {
      failTransport(error);
      return false;
    }
  };
  const sendRequest = (type, payload = {}) => {
    if (!writable()) return false;
    if (pendingRequests.size >= MAXIMUM_PENDING_REQUESTS ||
        !Number.isSafeInteger(nextSequence)) {
      const error = new Error("The Native Electron Bridge pending request limit was exceeded.");
      failTransport(error);
      socket.destroy();
      return false;
    }
    const sequence = nextSequence;
    nextSequence += 1;
    const requestID = String(sequence);
    pendingRequests.set(requestID, type);
    if (!writeEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      type,
      connectionID,
      sequence,
      requestID,
      ...payload,
    })) {
      pendingRequests.delete(requestID);
      return false;
    }
    return true;
  };
  const protocolFailure = (message) => {
    const error = new Error(message);
    failTransport(error);
    socket?.destroy();
  };
  const dispatchCommand = (webContentsID, command) => {
    const state = [...registrations.values()].find(
      (candidate) => candidate.webContents.id === webContentsID && !candidate.disposed,
    );
    if (!state || typeof command !== "string") return;
    if (command === FULL_SNAPSHOT_COMMAND &&
        !(typeof state.webContents.isDestroyed === "function" &&
          state.webContents.isDestroyed())) {
      Promise.resolve(state.webContents.executeJavaScript?.(FULL_SNAPSHOT_SCRIPT))
        .catch(() => undefined);
    }
    if (typeof commandListener === "function") {
      commandListener(Object.freeze({ type: command, webContentsId: webContentsID }));
    }
  };
  const handleMessage = (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message) ||
        message.protocolVersion !== PROTOCOL_VERSION ||
        message.connectionID !== connectionID || typeof message.type !== "string") {
      protocolFailure("The Native Electron Bridge sent an invalid protocol message.");
      return;
    }
    if (message.type === "ack") {
      const requestID = typeof message.requestID === "string" ? message.requestID : undefined;
      const requestType = requestID ? pendingRequests.get(requestID) : undefined;
      if (!requestType) {
        protocolFailure("The Native Electron Bridge acknowledged an unknown request.");
        return;
      }
      pendingRequests.delete(requestID);
      if (message.ok !== true && requestType !== "event") {
        protocolFailure(`The Native Electron Bridge rejected ${requestType}.`);
      }
      return;
    }
    if (message.type === "command") {
      const webContentsID = Number(message.webContentsID);
      if (Number.isSafeInteger(webContentsID) && webContentsID > 0) {
        dispatchCommand(webContentsID, message.command);
        return;
      }
    }
    protocolFailure("The Native Electron Bridge sent an unsupported protocol message.");
  };
  const consume = (data) => {
    input = Buffer.concat([input, data]);
    if (input.length > MAXIMUM_ENVELOPE_BYTES) {
      protocolFailure("The Native Electron Bridge response is too large.");
      return;
    }
    while (!socket.destroyed) {
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      if (newline === 0 || newline > MAXIMUM_ENVELOPE_BYTES) {
        protocolFailure("The Native Electron Bridge response is malformed.");
        return;
      }
      const line = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      let message;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch {
        protocolFailure("The Native Electron Bridge response is not valid JSON.");
        return;
      }
      handleMessage(message);
    }
  };
  const updateRegistration = (state, url = state.webContents.getURL?.() || "") => {
    state.hostAllowed = isAllowedHost(bridgeConfiguration.allowedWebViewHosts, url);
    if (!sendRequest("update", {
      webContentsID: state.webContents.id,
      visible: state.visible && state.hostAllowed,
    })) {
      throw new Error(`Native Electron Bridge rejected WebContents ${state.webContents.id} update.`);
    }
  };
  const cleanupRegistration = (state, unregister = true) => {
    if (!state || state.disposed) return;
    state.disposed = true;
    registrations.delete(state.registration);
    state.webContents.removeListener?.("did-start-navigation", state.onNavigation);
    if (unregister && writable() && !sendRequest("unregister", {
      webContentsID: state.webContents.id,
    })) {
      throw new Error(`Native Electron Bridge rejected WebContents ${state.webContents.id} removal.`);
    }
  };

  return {
    start() {
      if (started) return Promise.resolve(capabilities);
      if (starting) return starting;
      if (stopping) return Promise.reject(new Error("The macOS Mixed Mode adapter is stopped."));
      let credentials;
      try {
        credentials = resolveCredentials(options);
      } catch (error) {
        return Promise.reject(error);
      }
      starting = new Promise((resolve, reject) => {
        let settled = false;
        const finishFailure = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket?.destroy();
          reject(error);
        };
        const timer = setTimeout(() => finishFailure(new Error(
          "Timed out connecting to the Native Electron Bridge.",
        )), timeoutMs);
        timer.unref?.();
        socket = net.createConnection({ path: credentials.socketPath });
        socket.on("connect", () => {
          if (!writeEnvelope({
            protocolVersion: PROTOCOL_VERSION,
            type: "hello",
            connectionID,
            authenticationToken: credentials.authenticationToken,
          })) {
            finishFailure(new Error("Could not authenticate with the Native Electron Bridge."));
          }
        });
        socket.on("data", (data) => {
          if (started) {
            consume(data);
            return;
          }
          input = Buffer.concat([input, data]);
          if (input.length > MAXIMUM_ENVELOPE_BYTES) {
            finishFailure(new Error("The Native Electron Bridge handshake is too large."));
            return;
          }
          const newline = input.indexOf(0x0a);
          if (newline < 0) return;
          let message;
          try {
            message = JSON.parse(input.subarray(0, newline).toString("utf8"));
          } catch {
            finishFailure(new Error("The Native Electron Bridge handshake is not valid JSON."));
            return;
          }
          input = input.subarray(newline + 1);
          if (!message || message.protocolVersion !== PROTOCOL_VERSION ||
              message.type !== "ready" || message.connectionID !== connectionID ||
              !message.configuration) {
            finishFailure(new Error("The Native Electron Bridge handshake is invalid."));
            return;
          }
          try {
            bridgeConfiguration = parseBridgeConfiguration(message.configuration);
            if (!bridgeConfiguration.enableTraceWebView) {
              throw new Error("The macOS Native RUM WebView bridge is disabled.");
            }
          } catch (error) {
            finishFailure(error);
            return;
          }
          const replay = bridgeConfiguration.capabilities.includes("records");
          capabilities = Object.freeze({
            protocolVersion: PROTOCOL_VERSION,
            rum: true,
            log: bridgeConfiguration.enableWebViewLog,
            replay,
            trace: false,
            replayPrivacy: replay ? bridgeConfiguration.privacyLevel : "mask",
            traceSampleRate: 0,
            traceType: "w3c_traceparent",
            ...(bridgeConfiguration.allowedWebViewHosts
              ? { allowedWebViewHosts: bridgeConfiguration.allowedWebViewHosts }
              : {}),
          });
          started = true;
          settled = true;
          clearTimeout(timer);
          resolve(capabilities);
          if (input.length > 0) consume(Buffer.alloc(0));
        });
        socket.on("drain", () => { backpressured = false; });
        socket.on("error", (error) => {
          if (!started) finishFailure(error);
          else failTransport(error);
        });
        socket.on("close", () => {
          backpressured = false;
          if (!started) {
            finishFailure(new Error(
              "Native Electron Bridge closed before authentication completed.",
            ));
          } else if (!stopping) {
            failTransport(new Error("The Native Electron Bridge disconnected unexpectedly."));
          }
        });
      });
      return starting;
    },
    registerWebContents(registration) {
      if (!writable()) throw new Error("The macOS Mixed Mode adapter is not writable.");
      const webContents = registration.webContents;
      if (!Number.isSafeInteger(webContents?.id) || webContents.id <= 0) {
        throw new Error("macOS Mixed Mode requires a positive Electron WebContents ID.");
      }
      const state = {
        registration,
        webContents,
        visible: registration.metadata?.visible === undefined
          ? true
          : Boolean(registration.metadata.visible),
        hostAllowed: isAllowedHost(
          bridgeConfiguration.allowedWebViewHosts,
          webContents.getURL?.() || "",
        ),
        disposed: false,
      };
      state.onNavigation = (_event, url, _inPlace, mainFrame) => {
        if (mainFrame === false || state.disposed) return;
        try {
          updateRegistration(state, url);
        } catch (error) {
          failTransport(error);
        }
      };
      if (!sendRequest("register", {
        webContentsID: webContents.id,
        visible: state.visible && state.hostAllowed,
      })) {
        throw new Error(`Native Electron Bridge rejected WebContents ${webContents.id} registration.`);
      }
      registrations.set(registration, state);
      webContents.on?.("did-start-navigation", state.onNavigation);
    },
    updateWebContents(registration, metadata = {}) {
      const state = registrations.get(registration);
      if (!state || state.disposed) {
        throw new Error("The Electron WebContents is not registered with macOS Mixed Mode.");
      }
      if (metadata.visible !== undefined) state.visible = Boolean(metadata.visible);
      updateRegistration(state);
    },
    sendBrowserEvent(registration, serializedEvent) {
      if (!writable()) throw new Error("The macOS Mixed Mode adapter is not writable.");
      const state = registrations.get(registration);
      if (!state || state.disposed) {
        throw new Error("The Electron WebContents is not registered with macOS Mixed Mode.");
      }
      if (!state.visible || !state.hostAllowed) return;
      const event = parseBridgeEvent(serializedEvent);
      if (event.name === "log") {
        if (!capabilities.log) {
          throw new Error("Browser Log collection is not enabled by the Native host.");
        }
      }
      if (event.name === "session_replay" && !capabilities.replay) {
        throw new Error("Browser Session Replay is not enabled by the Native host.");
      }
      const messageQueue = JSON.stringify([{ handlerName: "sendEvent", data: serializedEvent }]);
      if (Buffer.byteLength(messageQueue, "utf8") > bridgeConfiguration.maximumMessageBytes) {
        throw new Error("Browser bridge message queue is too large for the Native host.");
      }
      if (!sendRequest("event", {
        webContentsID: state.webContents.id,
        payload: messageQueue,
      })) {
        throw new Error("Native Electron Bridge rejected the Browser bridge event.");
      }
    },
    unregisterWebContents(registration) {
      cleanupRegistration(registrations.get(registration));
    },
    onCommand(listener) {
      if (typeof listener !== "function") {
        throw new Error("Native Adapter command listener must be a function.");
      }
      commandListener = listener;
      return () => {
        if (commandListener === listener) commandListener = undefined;
      };
    },
    getState() {
      return Object.freeze({
        writable: writable() && !backpressured,
        backpressured,
        failure: transportFailure,
      });
    },
    stop() {
      if (stopped) return stopped;
      stopped = (async () => {
        if (starting && !started) {
          try {
            await starting;
          } catch {
            // Startup failure already owns socket cleanup.
          }
        }
        for (const state of [...registrations.values()]) {
          try {
            cleanupRegistration(state);
          } catch (error) {
            reportError(options.onError, error);
          }
        }
        if (writable()) sendRequest("close");
        stopping = true;
        commandListener = undefined;
        pendingRequests.clear();
        if (socket && !socket.destroyed) {
          await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              socket.destroy();
              finish();
            }, 3_000);
            timer.unref?.();
            socket.once("close", finish);
            socket.end();
          });
        }
        started = false;
      })();
      return stopped;
    },
  };
}

module.exports = {
  MIXED_MODE_ENVIRONMENT,
  createExternalSocketAdapter,
  resolveCredentials,
};
