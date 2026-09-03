"use strict";

const net = require("node:net");
const {
  DEFAULT_PIPE_NAME,
  MAX_CAPABILITIES_BYTES,
  MAX_BRIDGE_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} = require("../../core/channels.cjs");
const { normalizeCapabilities } = require("../../core/capabilities.cjs");
const { browserBridgeEventToNativeInput } = require("../../internal/rum-line-protocol.cjs");
const { inactiveCommandSubscription } = require("../../internal/native-adapter.cjs");
const { integer, reportError } = require("../../internal/options.cjs");

const RETRYABLE_PIPE_ERRORS = new Set(["ENOENT", "ECONNREFUSED", "EBUSY"]);

function resolvePipePath(pipeName = process.env.GUANCE_RUM_NATIVE_OWNED_PIPE_NAME) {
  const normalized = pipeName || DEFAULT_PIPE_NAME;
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(normalized)) {
    throw new Error("Native-owned pipe name must be a safe identifier.");
  }
  return `\\\\.\\pipe\\${normalized}`;
}

function parseBooleanCapability(fields, name) {
  const value = fields.get(name);
  if (value !== "0" && value !== "1") {
    throw new Error(`Native Bridge capability ${name} must be 0 or 1.`);
  }
  return value === "1";
}

function parseCapabilities(line) {
  const parts = line.split("\t");
  if (parts.shift() !== "@guance-capabilities") {
    throw new Error("Native Bridge Server did not provide a capabilities handshake.");
  }
  const fields = new Map();
  for (const part of parts) {
    const separator = part.indexOf("=");
    const name = part.slice(0, separator);
    if (separator <= 0 || fields.has(name)) {
      throw new Error("Native Bridge Server capabilities handshake is malformed.");
    }
    fields.set(name, part.slice(separator + 1));
  }
  if (fields.get("protocol") !== String(PROTOCOL_VERSION) || fields.get("rum") !== "1") {
    throw new Error(`Native Bridge Server does not support RUM bridge protocol ${PROTOCOL_VERSION}.`);
  }
  const traceSampleRate = Number(fields.get("trace_sample_rate") || 0);
  let allowedWebViewHosts;
  const hosts = fields.get("allowed_webview_hosts");
  if (hosts) {
    try {
      allowedWebViewHosts = JSON.parse(hosts);
    } catch {
      throw new Error("Native Bridge allowed WebView hosts capability is malformed.");
    }
  }
  return normalizeCapabilities({
    protocolVersion: PROTOCOL_VERSION,
    rum: true,
    log: parseBooleanCapability(fields, "log"),
    replay: parseBooleanCapability(fields, "replay"),
    trace: parseBooleanCapability(fields, "trace"),
    replayPrivacy: fields.get("replay_privacy") || "mask",
    traceSampleRate,
    traceType: fields.get("trace_type") || "w3c_traceparent",
    allowedWebViewHosts,
  });
}

function connectOnce(pipePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: pipePath });
    let pending = "";
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(
      "Timed out waiting for the Native Bridge capabilities handshake.",
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error(
      "Native Bridge Server closed before the capabilities handshake.",
    ));
    const onData = (chunk) => {
      pending += String(chunk);
      if (Buffer.byteLength(pending, "utf8") > MAX_CAPABILITIES_BYTES) {
        fail(new Error("Native Bridge Server capabilities handshake is too large."));
        return;
      }
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      try {
        const capabilities = parseCapabilities(pending.slice(0, newline).replace(/\r$/, ""));
        settled = true;
        cleanup();
        resolve({ socket, capabilities });
      } catch (error) {
        fail(error);
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function validateLaunchInput(line) {
  if (typeof line !== "string" ||
      !line.startsWith("@guance-launch\t") ||
      !line.endsWith("\n") ||
      /[\r\n\0]/u.test(line.slice(0, -1)) ||
      Buffer.byteLength(line, "utf8") > MAX_BRIDGE_PAYLOAD_BYTES) {
    throw new Error("Native Bridge launch input is invalid or too large.");
  }
}

function createNamedPipeAdapter({
  pipeName,
  pipePath = resolvePipePath(pipeName),
  timeoutMs = 10_000,
  retryDelayMs = 100,
  onError,
} = {}) {
  const timeoutLimit = integer(timeoutMs, 10_000, 1, 60_000, "native.timeoutMs");
  const retryLimit = integer(retryDelayMs, 100, 10, 5_000, "native.retryDelayMs");
  let socket;
  let capabilities;
  let disconnected;
  let disconnecting = false;
  let transportFailure;
  let backpressured = false;

  const failTransport = (error) => {
    if (disconnecting || transportFailure) return;
    transportFailure = error;
    reportError(onError, error);
  };
  const write = (line) => {
    if (transportFailure || backpressured || !socket?.writable || socket.destroyed) {
      throw new Error("The application-owned Native Bridge Server is not writable.");
    }
    try {
      if (!socket.write(line, "utf8")) backpressured = true;
    } catch (error) {
      failTransport(error);
      throw error;
    }
  };

  return {
    async start() {
      const deadline = Date.now() + timeoutLimit;
      let lastError;
      do {
        try {
          const connected = await connectOnce(pipePath, Math.max(1, deadline - Date.now()));
          socket = connected.socket;
          capabilities = connected.capabilities;
          socket.on("error", failTransport);
          socket.on("close", () => failTransport(new Error(
            "The application-owned Native Bridge Server disconnected unexpectedly.",
          )));
          socket.on("drain", () => { backpressured = false; });
          return capabilities;
        } catch (error) {
          lastError = error;
          if (!RETRYABLE_PIPE_ERRORS.has(error.code)) throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(retryLimit, remaining)));
        }
      } while (Date.now() < deadline);
      throw new Error(
        `Timed out connecting to the Native Bridge Server: ${lastError?.message || "unknown error"}`,
      );
    },
    registerWebContents() {},
    updateWebContents() {},
    sendBrowserEvent(_registration, serializedEvent) {
      const payload = browserBridgeEventToNativeInput(serializedEvent, { is_electron: "true" });
      if (payload.measurement === "log" && !capabilities.log) {
        throw new Error("Native Bridge Server did not enable Browser Log collection.");
      }
      if (payload.measurement === "session_replay" && !capabilities.replay) {
        throw new Error("Native Bridge Server did not enable Browser Session Replay.");
      }
      write(payload.line);
    },
    sendApplicationLaunch(line) {
      validateLaunchInput(line);
      write(line);
    },
    unregisterWebContents() {},
    onCommand: inactiveCommandSubscription,
    getState() {
      return Object.freeze({
        writable: Boolean(!transportFailure && !backpressured && socket?.writable && !socket.destroyed),
        backpressured,
        failure: transportFailure,
      });
    },
    stop() {
      if (disconnected) return disconnected;
      disconnecting = true;
      disconnected = new Promise((resolve) => {
        if (!socket || socket.destroyed) {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          socket.destroy();
          finish();
        }, 3_000);
        socket.once("close", finish);
        socket.end();
      });
      return disconnected;
    },
  };
}

module.exports = {
  createNamedPipeAdapter,
  parseCapabilities,
  resolvePipePath,
};
