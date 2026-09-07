"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROTOCOL_VERSION, MAX_BRIDGE_PAYLOAD_BYTES } = require("../../core/channels.cjs");
const { normalizeNativeSettings } = require("../../internal/native-settings.cjs");
const { parseBridgeEvent } = require("../../internal/rum-line-protocol.cjs");
const { reportError, requiredString } = require("../../internal/options.cjs");

const REQUIRED_BINDING_METHODS = [
  "invoke",
  "getElectronBridgeConfiguration",
  "registerElectronWebContents",
  "updateElectronWebContents",
  "receiveElectronWebContentsMessage",
  "unregisterElectronWebContents",
  "setElectronCommandHandler",
];
const REPLAY_PRIVACY_LEVELS = new Set(["allow", "mask-user-input", "mask"]);
const FULL_SNAPSHOT_COMMAND = "takeSubsequentFullSnapshot";
const FULL_SNAPSHOT_SCRIPT = "window.DATAFLUX_RUM?.takeSubsequentFullSnapshot()";

let nextSlotId = Date.now() * 1_000;

function allocateSlotId() {
  nextSlotId += 1;
  if (!Number.isSafeInteger(nextSlotId)) nextSlotId = Date.now() * 1_000;
  return nextSlotId;
}

function assertNativeBinding(binding) {
  if (!binding || typeof binding !== "object") {
    throw new Error("The macOS Native binding must be an object.");
  }
  for (const method of REQUIRED_BINDING_METHODS) {
    if (typeof binding[method] !== "function") {
      throw new Error(`The macOS Native binding must provide ${method}().`);
    }
  }
  return binding;
}

function loadNativeBinding(directory) {
  const nativeDirectory = path.resolve(requiredString(directory, "native.directory"));
  const addonPath = path.join(nativeDirectory, "guance_electron.node");
  if (!fs.existsSync(addonPath)) {
    throw new Error(`The installed macOS native runtime is missing: ${addonPath}`);
  }
  const bundles = fs.readdirSync(nativeDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".bundle"));
  if (bundles.length === 0) {
    throw new Error(`The installed macOS native runtime has no resource bundle: ${nativeDirectory}`);
  }
  try {
    return assertNativeBinding(require(addonPath));
  } catch (error) {
    throw new Error(`Could not load the macOS Native binding at ${addonPath}: ${error.message}`);
  }
}

function nativeSampling(rate) {
  return Math.round(rate * 100);
}

function nativeTraceType(traceType) {
  const types = {
    ddtrace: "ddTrace",
    zipkin: "zipkinMulti",
    zipkin_multi: "zipkinMulti",
    zipkin_single_header: "zipkinSingle",
    w3c_traceparent: "traceparent",
    skywalking_v3: "skywalking",
    jaeger: "jaeger",
  };
  return types[traceType] || traceType;
}

function sessionReplayPrivacy(privacy) {
  if (privacy === "allow") {
    return {
      touchPrivacy: "show",
      textAndInputPrivacy: "maskSensitiveInputs",
      imagePrivacy: "maskNone",
    };
  }
  if (privacy === "mask-user-input") {
    return {
      touchPrivacy: "show",
      textAndInputPrivacy: "maskAllInputs",
      imagePrivacy: "maskNonBundledOnly",
    };
  }
  return {
    touchPrivacy: "hide",
    textAndInputPrivacy: "maskAll",
    imagePrivacy: "maskAll",
  };
}

function nativeConfigurations(settings) {
  const sdk = settings.datakitUrl
    ? { datakitUrl: settings.datakitUrl }
    : {
        datawayUrl: settings.datawayUrl,
        clientToken: requiredString(
          settings.clientToken,
          "native.settings.clientToken",
        ),
      };
  Object.assign(sdk, {
    env: settings.environment,
    service: settings.service,
    debug: settings.debug,
    version: settings.version,
    cachePath: settings.cachePath,
    httpTimeoutMs: settings.httpTimeoutMs,
  });
  return Object.freeze({
    sdk: Object.freeze(sdk),
    rum: Object.freeze({
      appId: settings.applicationId,
      sampleRate: nativeSampling(settings.sampleRate),
      enableTraceWebView: true,
    }),
    logger: Object.freeze({
      sampleRate: nativeSampling(settings.loggingSampleRate),
      enableCustomLog: true,
      enableLinkRumData: true,
    }),
    trace: Object.freeze({
      sampleRate: nativeSampling(settings.traceSampleRate),
      traceType: nativeTraceType(settings.traceType),
      enableAutoTrace: true,
      enableLinkRumData: true,
    }),
    replay: Object.freeze({
      sampleRate: nativeSampling(settings.replaySampleRate),
      ...sessionReplayPrivacy(settings.replayPrivacy),
    }),
  });
}

function parseBridgeConfiguration(value) {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new Error("The macOS Native bridge configuration is not valid JSON.");
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("The macOS Native bridge configuration must be an object.");
  }
  const maximumMessageBytes = candidate.maximumMessageBytes ?? MAX_BRIDGE_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes <= 0) {
    throw new Error("The macOS Native bridge message limit is invalid.");
  }
  let bridgeCapabilities = [];
  if (typeof candidate.capabilities === "string") {
    try {
      bridgeCapabilities = JSON.parse(candidate.capabilities);
    } catch {
      throw new Error("The macOS Native bridge capabilities are not valid JSON.");
    }
  } else if (Array.isArray(candidate.capabilities)) {
    bridgeCapabilities = candidate.capabilities;
  }
  if (!Array.isArray(bridgeCapabilities) ||
      bridgeCapabilities.some((capability) => typeof capability !== "string")) {
    throw new Error("The macOS Native bridge capabilities must be an array of strings.");
  }
  const allowedWebViewHosts = candidate.allowedWebViewHosts === null ||
      candidate.allowedWebViewHosts === undefined
    ? undefined
    : candidate.allowedWebViewHosts;
  if (allowedWebViewHosts !== undefined &&
      (!Array.isArray(allowedWebViewHosts) ||
       allowedWebViewHosts.some((host) => typeof host !== "string" || !host.trim()))) {
    throw new Error("The macOS Native allowed WebView hosts are invalid.");
  }
  return Object.freeze({
    enableTraceWebView: candidate.enableTraceWebView === true,
    allowedWebViewHosts: allowedWebViewHosts?.map((host) => host.trim()),
    maximumMessageBytes,
    capabilities: Object.freeze([...bridgeCapabilities]),
    privacyLevel: REPLAY_PRIVACY_LEVELS.has(candidate.privacyLevel)
      ? candidate.privacyLevel
      : "mask",
  });
}

function isAllowedHost(allowedHosts, url) {
  if (allowedHosts === undefined) return true;
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((item) => {
    const host = item.toLowerCase();
    return hostname === host || hostname.endsWith(`.${host}`);
  });
}

function normalizeBounds(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Window metadata bounds must be an object.");
  }
  const bounds = {};
  for (const key of ["x", "y", "width", "height"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new Error(`Window metadata bounds.${key} must be a finite number.`);
    }
    bounds[key] = value[key];
  }
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("Window metadata bounds must have positive width and height.");
  }
  return bounds;
}

function normalizedWindowMetadata(metadata = {}, previous) {
  const visible = metadata.visible === undefined
    ? previous?.visible ?? true
    : Boolean(metadata.visible);
  const zIndex = metadata.zIndex === undefined ? previous?.zIndex ?? 0 : metadata.zIndex;
  if (!Number.isInteger(zIndex)) {
    throw new Error("Window metadata zIndex must be an integer.");
  }
  const bounds = metadata.bounds === undefined
    ? previous?.bounds
    : normalizeBounds(metadata.bounds);
  return { visible, zIndex, bounds };
}

function resolveHostWindow(registration, electron) {
  const container = registration.container;
  if (container?.webContents === registration.webContents &&
      typeof container.getNativeWindowHandle === "function") {
    return container;
  }
  const explicit = registration.metadata?.hostWindow;
  if (explicit?.webContents === registration.webContents &&
      typeof explicit.getNativeWindowHandle === "function") {
    return explicit;
  }
  const resolved = electron?.BrowserWindow?.fromWebContents?.(registration.webContents);
  if (resolved && typeof resolved.getNativeWindowHandle === "function") return resolved;
  throw new Error(
    "macOS managed mode requires a BrowserWindow with getNativeWindowHandle().",
  );
}

function nativeWindowHandle(hostWindow) {
  const handle = hostWindow.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 1) {
    throw new Error("Electron BrowserWindow returned an invalid macOS native window handle.");
  }
  return handle;
}

function browserLogInvocation(event) {
  const { message, status, ...attributes } = event.record;
  return {
    content: message,
    status: status.toLowerCase() === "warn" ? "warning" : status.toLowerCase(),
    attributes,
  };
}

function createManagedAdapter({ directory, settings, binding: suppliedBinding, electron, onError } = {}) {
  let binding;
  let normalized;
  let bridgeConfiguration;
  let capabilities;
  let initialized = false;
  let started = false;
  let stopping = false;
  let stopped;
  let transportFailure;
  let commandListener;
  const registrations = new Map();
  const pendingInvocations = new Set();

  const failTransport = (error) => {
    if (stopping || transportFailure) return;
    transportFailure = error;
    reportError(onError, error);
  };
  const invoke = async (method, payload = {}) => {
    let result;
    try {
      result = await binding.invoke(method, JSON.stringify(payload));
    } catch (error) {
      throw new Error(`macOS Native ${method} failed: ${error.message}`);
    }
    if (result === undefined || result === "") return undefined;
    if (typeof result !== "string") {
      throw new Error(`macOS Native ${method} returned an invalid result.`);
    }
    try {
      return JSON.parse(result);
    } catch {
      throw new Error(`macOS Native ${method} returned invalid JSON.`);
    }
  };
  const trackInvocation = (promise) => {
    pendingInvocations.add(promise);
    promise.catch(failTransport).finally(() => pendingInvocations.delete(promise));
  };
  const updateNativeRegistration = (state, url = state.webContents.getURL?.() || "") => {
    state.hostAllowed = isAllowedHost(
      bridgeConfiguration.allowedWebViewHosts,
      url,
    );
    const accepted = binding.updateElectronWebContents(
      nativeWindowHandle(state.hostWindow),
      state.webContents.id,
      state.visible && state.hostAllowed,
      state.zIndex,
      state.bounds,
    );
    if (!accepted) {
      throw new Error(`macOS Native rejected WebContents ${state.webContents.id} update.`);
    }
  };
  const cleanupRegistration = (state, unregister = true) => {
    if (!state || state.disposed) return;
    state.disposed = true;
    registrations.delete(state.registration);
    state.webContents.removeListener?.("did-start-navigation", state.onNavigation);
    state.hostWindow.removeListener?.("resize", state.onResize);
    if (unregister) binding.unregisterElectronWebContents(state.webContents.id);
  };
  const dispatchCommand = (webContentsId, command) => {
    const state = [...registrations.values()].find(
      (candidate) => candidate.webContents.id === webContentsId && !candidate.disposed,
    );
    if (state && command === FULL_SNAPSHOT_COMMAND &&
        !(typeof state.webContents.isDestroyed === "function" && state.webContents.isDestroyed())) {
      Promise.resolve(state.webContents.executeJavaScript?.(FULL_SNAPSHOT_SCRIPT))
        .catch(() => undefined);
    }
    if (typeof commandListener === "function") {
      commandListener(Object.freeze({ type: command, webContentsId }));
    }
  };

  return {
    async start() {
      if (started) return capabilities;
      if (stopping) throw new Error("The macOS managed adapter is stopped.");
      normalized = normalizeNativeSettings(settings);
      const configuration = nativeConfigurations(normalized);
      binding = suppliedBinding
        ? assertNativeBinding(suppliedBinding)
        : loadNativeBinding(directory);
      try {
        await invoke("sdk.initialize", configuration.sdk);
        initialized = true;
        await invoke("rum.configure", configuration.rum);
        if (normalized.loggingEnabled) await invoke("logger.configure", configuration.logger);
        if (normalized.traceEnabled) await invoke("trace.configure", configuration.trace);
        if (normalized.replayEnabled) {
          await invoke("sessionReplay.configure", configuration.replay);
        }
        bridgeConfiguration = parseBridgeConfiguration(
          binding.getElectronBridgeConfiguration(),
        );
        if (!bridgeConfiguration.enableTraceWebView) {
          throw new Error("The macOS Native RUM WebView bridge is disabled.");
        }
        const replay = normalized.replayEnabled &&
          bridgeConfiguration.capabilities.includes("records");
        capabilities = Object.freeze({
          protocolVersion: PROTOCOL_VERSION,
          rum: true,
          log: normalized.loggingEnabled,
          replay,
          trace: normalized.traceEnabled,
          replayPrivacy: replay ? bridgeConfiguration.privacyLevel : "mask",
          traceSampleRate: nativeSampling(normalized.traceSampleRate),
          traceType: normalized.traceType,
          ...(bridgeConfiguration.allowedWebViewHosts
            ? { allowedWebViewHosts: bridgeConfiguration.allowedWebViewHosts }
            : {}),
        });
        binding.setElectronCommandHandler(dispatchCommand);
        started = true;
        return capabilities;
      } catch (error) {
        transportFailure = error;
        try {
          binding.setElectronCommandHandler(null);
          if (initialized) {
            await invoke("sdk.shutdown");
            initialized = false;
          }
        } catch (cleanupError) {
          reportError(onError, cleanupError);
        }
        throw error;
      }
    },
    registerWebContents(registration) {
      if (!started || stopping || transportFailure) {
        throw new Error("The macOS managed adapter is not writable.");
      }
      const webContents = registration.webContents;
      if (!Number.isSafeInteger(webContents?.id) || webContents.id <= 0) {
        throw new Error("macOS managed mode requires a positive Electron WebContents ID.");
      }
      const hostWindow = resolveHostWindow(registration, electron);
      const metadata = normalizedWindowMetadata(registration.metadata);
      const state = {
        registration,
        webContents,
        hostWindow,
        ...metadata,
        hostAllowed: isAllowedHost(
          bridgeConfiguration.allowedWebViewHosts,
          webContents.getURL?.() || "",
        ),
        disposed: false,
      };
      state.onNavigation = (_event, url, _inPlace, mainFrame) => {
        if (mainFrame === false || state.disposed) return;
        try {
          updateNativeRegistration(state, url);
        } catch (error) {
          failTransport(error);
        }
      };
      state.onResize = () => {
        if (state.disposed) return;
        try {
          updateNativeRegistration(state);
        } catch (error) {
          failTransport(error);
        }
      };
      const accepted = binding.registerElectronWebContents(
        nativeWindowHandle(hostWindow),
        webContents.id,
        allocateSlotId(),
        state.visible && state.hostAllowed,
        state.zIndex,
        state.bounds,
      );
      if (!accepted) {
        throw new Error(`macOS Native rejected WebContents ${webContents.id} registration.`);
      }
      registrations.set(registration, state);
      webContents.on?.("did-start-navigation", state.onNavigation);
      hostWindow.on?.("resize", state.onResize);
    },
    updateWebContents(registration, metadata) {
      const state = registrations.get(registration);
      if (!state || state.disposed) {
        throw new Error("The Electron WebContents is not registered with macOS Native.");
      }
      Object.assign(state, normalizedWindowMetadata(metadata, state));
      const nextHost = metadata.hostWindow;
      if (nextHost && nextHost !== state.hostWindow) {
        if (nextHost.webContents !== state.webContents ||
            typeof nextHost.getNativeWindowHandle !== "function") {
          throw new Error("Window metadata hostWindow is invalid.");
        }
        state.hostWindow.removeListener?.("resize", state.onResize);
        state.hostWindow = nextHost;
        state.hostWindow.on?.("resize", state.onResize);
      }
      updateNativeRegistration(state);
    },
    sendBrowserEvent(registration, serializedEvent) {
      if (!started || stopping || transportFailure) {
        throw new Error("The macOS managed adapter is not writable.");
      }
      const state = registrations.get(registration);
      if (!state || state.disposed) {
        throw new Error("The Electron WebContents is not registered with macOS Native.");
      }
      if (!state.visible || !state.hostAllowed) return;
      const event = parseBridgeEvent(serializedEvent);
      if (event.name === "log") {
        if (!capabilities.log) {
          throw new Error("Browser Log collection is not enabled in the native settings.");
        }
        trackInvocation(invoke("logger.log", browserLogInvocation(event)));
        return;
      }
      if (event.name === "session_replay" && !capabilities.replay) {
        throw new Error("Browser Session Replay is not enabled in the native settings.");
      }
      const messageQueue = JSON.stringify([{ handlerName: "sendEvent", data: serializedEvent }]);
      if (Buffer.byteLength(messageQueue, "utf8") > bridgeConfiguration.maximumMessageBytes) {
        throw new Error("Browser bridge message queue is too large for macOS Native.");
      }
      if (!binding.receiveElectronWebContentsMessage(state.webContents.id, messageQueue)) {
        throw new Error("macOS Native rejected the Browser bridge event.");
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
        writable: Boolean(started && !stopping && !transportFailure),
        backpressured: false,
        failure: transportFailure,
      });
    },
    stop() {
      if (stopped) return stopped;
      stopping = true;
      stopped = (async () => {
        let firstError;
        try {
          binding?.setElectronCommandHandler(null);
        } catch (error) {
          firstError = error;
        }
        for (const state of [...registrations.values()]) {
          try {
            cleanupRegistration(state);
          } catch (error) {
            firstError ||= error;
          }
        }
        await Promise.allSettled([...pendingInvocations]);
        if (initialized) {
          try {
            await invoke("sdk.shutdown");
            initialized = false;
          } catch (error) {
            firstError ||= error;
          }
        }
        started = false;
        if (firstError) throw firstError;
      })();
      return stopped;
    },
  };
}

module.exports = {
  assertNativeBinding,
  createManagedAdapter,
  isAllowedHost,
  loadNativeBinding,
  nativeConfigurations,
  nativeSampling,
  nativeTraceType,
  parseBridgeConfiguration,
  sessionReplayPrivacy,
};
