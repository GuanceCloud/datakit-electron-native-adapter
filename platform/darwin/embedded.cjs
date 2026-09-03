"use strict";

const {
  MAX_BRIDGE_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} = require("../../core/channels.cjs");
const { parseBridgeEvent } = require("../../internal/rum-line-protocol.cjs");
const { reportError, requireObject } = require("../../internal/options.cjs");

const REQUIRED_BRIDGE_METHODS = [
  "getElectronBridgeConfiguration",
  "registerElectronWebContents",
  "updateElectronWebContents",
  "receiveElectronWebContentsMessage",
  "unregisterElectronWebContents",
];
const REPLAY_PRIVACY_LEVELS = new Set(["allow", "mask-user-input", "mask"]);
const TAKE_SUBSEQUENT_FULL_SNAPSHOT = "takeSubsequentFullSnapshot";
const TAKE_SUBSEQUENT_FULL_SNAPSHOT_SCRIPT =
  "window.DATAFLUX_RUM?.takeSubsequentFullSnapshot()";
const bridgeOwners = new WeakMap();

let nextSlotId = Date.now() * 1_000;

function allocateSlotId() {
  if (!Number.isSafeInteger(nextSlotId)) {
    nextSlotId = Date.now() * 1_000;
  }
  return nextSlotId++;
}

function assertNativeBridge(bridge) {
  requireObject(bridge, "native.bridge");
  for (const method of REQUIRED_BRIDGE_METHODS) {
    if (typeof bridge[method] !== "function") {
      throw new Error(`macOS embedded bridge must provide ${method}().`);
    }
  }
  if (bridge.setElectronCommandHandler !== undefined &&
      typeof bridge.setElectronCommandHandler !== "function") {
    throw new Error("macOS embedded bridge setElectronCommandHandler must be a function.");
  }
  return bridge;
}

function parseJson(value, label) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`macOS embedded bridge returned malformed ${label} JSON.`);
  }
}

function parseBridgeConfiguration(value) {
  const configuration = parseJson(value, "configuration");
  if (!configuration || typeof configuration !== "object" ||
      Array.isArray(configuration)) {
    throw new Error("macOS embedded bridge configuration must be an object.");
  }
  if (typeof configuration.enableTraceWebView !== "boolean") {
    throw new Error("macOS embedded bridge enableTraceWebView must be a boolean.");
  }

  const replayFeatures = parseJson(configuration.capabilities ?? "[]", "capabilities");
  if (!Array.isArray(replayFeatures) ||
      replayFeatures.some((feature) => typeof feature !== "string")) {
    throw new Error("macOS embedded bridge capabilities must be an array of strings.");
  }
  const replay = replayFeatures.includes("records");
  const replayPrivacy = replay ? configuration.privacyLevel : "mask";
  if (!REPLAY_PRIVACY_LEVELS.has(replayPrivacy)) {
    throw new Error("macOS embedded bridge Replay privacy is invalid.");
  }

  let allowedWebViewHosts;
  if (configuration.allowedWebViewHosts !== undefined &&
      configuration.allowedWebViewHosts !== null) {
    if (!Array.isArray(configuration.allowedWebViewHosts) ||
        configuration.allowedWebViewHosts.some(
          (host) => typeof host !== "string" || !host.trim(),
        )) {
      throw new Error("macOS embedded bridge allowedWebViewHosts must be an array of strings.");
    }
    allowedWebViewHosts = configuration.allowedWebViewHosts.map((host) => host.trim());
  }

  const maximumMessageBytes = configuration.maximumMessageBytes ?? MAX_BRIDGE_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes <= 0 ||
      maximumMessageBytes > MAX_BRIDGE_PAYLOAD_BYTES) {
    throw new Error(
      `macOS embedded bridge maximumMessageBytes must be from 1 through ${MAX_BRIDGE_PAYLOAD_BYTES}.`,
    );
  }

  return Object.freeze({
    autoAttachEnabled: configuration.enableTraceWebView,
    maximumMessageBytes,
    capabilities: Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      rum: true,
      log: false,
      replay,
      trace: false,
      replayPrivacy,
      traceSampleRate: 100,
      traceType: "w3c_traceparent",
      ...(allowedWebViewHosts
        ? { allowedWebViewHosts: Object.freeze(allowedWebViewHosts) }
        : {}),
    }),
  });
}

function normalizeBounds(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Window metadata bounds must be an object or null.");
  }
  const bounds = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  };
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
      bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("Window metadata bounds must be a finite non-empty rectangle.");
  }
  return bounds;
}

function hostFromUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isAllowedHost(allowedHosts, url) {
  if (!allowedHosts) return true;
  const currentHost = hostFromUrl(url);
  if (!currentHost) return false;
  return allowedHosts.some((value) => {
    const allowedHost = value.toLowerCase();
    return currentHost === allowedHost || currentHost.endsWith(`.${allowedHost}`);
  });
}

function registrationMetadata(registration, metadata) {
  const container = registration.container;
  const hostWindow = typeof container?.getNativeWindowHandle === "function"
    ? container
    : metadata.browserWindow;
  if (typeof hostWindow?.getNativeWindowHandle !== "function") {
    throw new Error(
      "macOS embedded attachment requires a BrowserWindow container or metadata.browserWindow.",
    );
  }
  const webContentsId = registration.webContents?.id;
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
    throw new Error("macOS embedded attachment requires a positive WebContents id.");
  }
  const visible = metadata.visible ?? true;
  if (typeof visible !== "boolean") {
    throw new Error("Window metadata visible must be a boolean.");
  }
  const zIndex = metadata.zIndex ?? 0;
  if (!Number.isInteger(zIndex)) {
    throw new Error("Window metadata zIndex must be an integer.");
  }
  const implicitBounds = typeof container?.getNativeWindowHandle !== "function" &&
    typeof container?.getBounds === "function"
    ? container.getBounds()
    : null;
  return {
    bounds: normalizeBounds(
      Object.prototype.hasOwnProperty.call(metadata, "bounds")
        ? metadata.bounds
        : implicitBounds,
    ),
    hostWindow,
    visible,
    webContentsId,
    zIndex,
  };
}

function createDarwinEmbeddedAdapter({ bridge, onError } = {}) {
  const nativeBridge = assertNativeBridge(bridge);
  const registrations = new Map();
  const commandListeners = new Set();
  let configuration;
  let started = false;
  let stopping = false;
  let stopped;
  let transportFailure;

  const failTransport = (error) => {
    transportFailure ||= error;
    return error;
  };

  const requireWritable = () => {
    if (!started || stopping || transportFailure) {
      throw new Error("The macOS embedded Native Bridge is not writable.");
    }
  };

  const invoke = (method, ...args) => {
    requireWritable();
    try {
      const result = nativeBridge[method](...args);
      if (result === false) {
        throw new Error(`macOS embedded Native Bridge rejected ${method}().`);
      }
      return result;
    } catch (error) {
      throw failTransport(error);
    }
  };

  const updateNativeRegistration = (record) => {
    const next = registrationMetadata(record.registration, record.registration.metadata);
    record.hostWindow = next.hostWindow;
    record.visible = next.visible;
    record.zIndex = next.zIndex;
    record.bounds = next.bounds;
    record.hostAllowed = isAllowedHost(
      configuration.capabilities.allowedWebViewHosts,
      record.registration.webContents.getURL?.(),
    );
    invoke(
      "updateElectronWebContents",
      record.nativeWindowHandle,
      record.webContentsId,
      record.visible && record.hostAllowed,
      record.zIndex,
      record.bounds,
    );
  };

  const handleNativeCommand = (webContentsId, command) => {
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0 ||
        command !== TAKE_SUBSEQUENT_FULL_SNAPSHOT) {
      reportError(onError, new Error("macOS embedded Native Bridge emitted an invalid command."));
      return false;
    }
    const record = registrations.get(webContentsId);
    if (!record || record.registration.webContents.isDestroyed?.()) return false;

    if (typeof record.registration.webContents.executeJavaScript === "function") {
      Promise.resolve(record.registration.webContents.executeJavaScript(
        TAKE_SUBSEQUENT_FULL_SNAPSHOT_SCRIPT,
      )).catch((error) => reportError(onError, error));
    }
    const normalized = Object.freeze({
      type: TAKE_SUBSEQUENT_FULL_SNAPSHOT,
      webContentsId,
    });
    for (const listener of commandListeners) {
      try {
        listener(normalized);
      } catch (error) {
        reportError(onError, error);
      }
    }
    return true;
  };

  const adapter = {
    get autoAttachEnabled() {
      return configuration?.autoAttachEnabled ?? true;
    },

    async start() {
      if (started) return configuration.capabilities;
      configuration = parseBridgeConfiguration(
        nativeBridge.getElectronBridgeConfiguration(),
      );
      if (typeof nativeBridge.setElectronCommandHandler === "function") {
        if (bridgeOwners.has(nativeBridge)) {
          throw new Error("The macOS embedded Native Bridge is already in use.");
        }
        bridgeOwners.set(nativeBridge, adapter);
        try {
          nativeBridge.setElectronCommandHandler(handleNativeCommand);
        } catch (error) {
          bridgeOwners.delete(nativeBridge);
          throw error;
        }
      }
      started = true;
      return configuration.capabilities;
    },

    registerWebContents(registration) {
      requireWritable();
      const metadata = registrationMetadata(registration, registration.metadata);
      if (registrations.has(metadata.webContentsId)) {
        throw new Error(`WebContents ${metadata.webContentsId} is already registered.`);
      }
      const nativeWindowHandle = metadata.hostWindow.getNativeWindowHandle();
      if (!Buffer.isBuffer(nativeWindowHandle) || nativeWindowHandle.length === 0) {
        throw new Error("BrowserWindow.getNativeWindowHandle() returned an invalid handle.");
      }
      const hostAllowed = isAllowedHost(
        configuration.capabilities.allowedWebViewHosts,
        registration.webContents.getURL?.(),
      );
      const record = {
        ...metadata,
        registration,
        nativeWindowHandle,
        hostAllowed,
        slotId: allocateSlotId(),
      };
      invoke(
        "registerElectronWebContents",
        nativeWindowHandle,
        record.webContentsId,
        record.slotId,
        record.visible && record.hostAllowed,
        record.zIndex,
        record.bounds,
      );
      record.navigationHandler = (_event, url, isInPlace, isMainFrame) => {
        if (isInPlace === true || isMainFrame === false) return;
        const allowed = isAllowedHost(configuration.capabilities.allowedWebViewHosts, url);
        if (record.hostAllowed === allowed) return;
        record.hostAllowed = allowed;
        try {
          invoke(
            "updateElectronWebContents",
            record.nativeWindowHandle,
            record.webContentsId,
            record.visible && record.hostAllowed,
            record.zIndex,
            record.bounds,
          );
        } catch (error) {
          reportError(onError, error);
        }
      };
      registration.webContents.on?.("did-start-navigation", record.navigationHandler);
      registrations.set(record.webContentsId, record);
    },

    updateWebContents(registration) {
      requireWritable();
      const record = registrations.get(registration.webContents?.id);
      if (!record || record.registration !== registration) {
        throw new Error("The macOS embedded WebContents is not registered.");
      }
      updateNativeRegistration(record);
    },

    sendBrowserEvent(registration, serializedEvent) {
      requireWritable();
      const record = registrations.get(registration.webContents?.id);
      if (!record || record.registration !== registration) {
        throw new Error("The macOS embedded WebContents is not registered.");
      }
      if (!record.hostAllowed) return;
      const event = parseBridgeEvent(serializedEvent);
      if (event.name === "log") {
        throw new Error("macOS embedded mode does not support Browser Log collection.");
      }
      if (event.name === "session_replay" && !configuration.capabilities.replay) {
        throw new Error("macOS embedded Native SDK did not enable Browser Session Replay.");
      }
      const messageQueue = JSON.stringify([
        { handlerName: "sendEvent", data: serializedEvent },
      ]);
      if (Buffer.byteLength(messageQueue, "utf8") > configuration.maximumMessageBytes) {
        throw new Error("Browser RUM bridge payload exceeds the macOS Native Bridge limit.");
      }
      invoke(
        "receiveElectronWebContentsMessage",
        record.webContentsId,
        messageQueue,
      );
    },

    unregisterWebContents(registration) {
      const record = registrations.get(registration.webContents?.id);
      if (!record || record.registration !== registration) return;
      registrations.delete(record.webContentsId);
      registration.webContents.removeListener?.(
        "did-start-navigation",
        record.navigationHandler,
      );
      if (!stopping) {
        invoke("unregisterElectronWebContents", record.webContentsId);
      } else {
        nativeBridge.unregisterElectronWebContents(record.webContentsId);
      }
    },

    onCommand(listener) {
      if (typeof listener !== "function") {
        throw new Error("Native Adapter command listener must be a function.");
      }
      commandListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        commandListeners.delete(listener);
      };
    },

    getState() {
      return Object.freeze({
        writable: Boolean(started && !stopping && !transportFailure),
        backpressured: false,
        failure: transportFailure,
      });
    },

    stop() {
      if (stopped) return stopped;
      stopping = true;
      stopped = Promise.resolve().then(() => {
        let firstError;
        for (const record of [...registrations.values()]) {
          try {
            adapter.unregisterWebContents(record.registration);
          } catch (error) {
            firstError ||= error;
          }
        }
        commandListeners.clear();
        if (bridgeOwners.get(nativeBridge) === adapter) {
          bridgeOwners.delete(nativeBridge);
          try {
            nativeBridge.setElectronCommandHandler(null);
          } catch (error) {
            firstError ||= error;
          }
        }
        started = false;
        if (firstError) throw firstError;
      });
      return stopped;
    },
  };

  return adapter;
}

module.exports = {
  createDarwinEmbeddedAdapter,
  parseBridgeConfiguration,
};
