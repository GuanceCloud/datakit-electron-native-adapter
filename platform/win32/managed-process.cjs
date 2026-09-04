"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { parseCapabilities } = require("./named-pipe.cjs");
const {
  browserBridgeEventToNativeInput,
} = require("../../internal/rum-line-protocol.cjs");
const { inactiveCommandSubscription } = require("../../internal/native-adapter.cjs");
const { normalizeNativeSettings } = require("../../internal/native-settings.cjs");
const {
  integer,
  reportError,
  requiredString,
} = require("../../internal/options.cjs");

function mapNativeSettings(settings) {
  const normalized = normalizeNativeSettings(settings);
  return {
    normalized,
    nativeEnvironment: {
      GUANCE_RUM_NATIVE_DATAKIT_URL: normalized.datakitUrl,
      GUANCE_RUM_NATIVE_DATAWAY_URL: normalized.datawayUrl,
      GUANCE_RUM_NATIVE_CLIENT_TOKEN: normalized.clientToken,
      GUANCE_RUM_NATIVE_APP_ID: normalized.applicationId,
      GUANCE_RUM_NATIVE_SERVICE: normalized.service,
      GUANCE_RUM_NATIVE_ENV: normalized.environment,
      GUANCE_RUM_NATIVE_VERSION: normalized.version,
      GUANCE_RUM_NATIVE_CACHE_PATH: normalized.cachePath,
      GUANCE_RUM_NATIVE_SAMPLE_RATE: String(normalized.sampleRate),
      GUANCE_RUM_NATIVE_ACTION_TRACKING_ENABLED: normalized.actionTrackingEnabled ? "1" : "0",
      GUANCE_RUM_NATIVE_LOG_ENABLED: normalized.loggingEnabled ? "1" : "0",
      GUANCE_RUM_NATIVE_LOG_SAMPLE_RATE: String(normalized.loggingSampleRate),
      GUANCE_RUM_NATIVE_SESSION_REPLAY_ENABLED: normalized.replayEnabled ? "1" : "0",
      GUANCE_RUM_NATIVE_SESSION_REPLAY_SAMPLE_RATE: String(normalized.replaySampleRate),
      GUANCE_RUM_NATIVE_REPLAY_PRIVACY_LEVEL: normalized.replayPrivacy,
      GUANCE_RUM_NATIVE_TRACE_ENABLED: normalized.traceEnabled ? "1" : "0",
      GUANCE_RUM_NATIVE_TRACE_SAMPLE_RATE: String(normalized.traceSampleRate),
      GUANCE_RUM_NATIVE_TRACE_TYPE: normalized.traceType,
      GUANCE_RUM_NATIVE_TRACE_ALLOWED_URLS: normalized.traceAllowedUrls,
      GUANCE_RUM_NATIVE_DEBUG: normalized.debug ? "1" : "0",
      GUANCE_RUM_NATIVE_HTTP_TIMEOUT_MS: String(normalized.httpTimeoutMs),
    },
  };
}

function waitForReady(child, timeoutMs, onNativeOutput) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = "";
    let stderr = "";
    const timeout = setTimeout(() => fail(new Error(
      "Timed out waiting for the CloudCare Electron Bridge EXE handshake.",
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => fail(new Error(
      `CloudCare Electron Bridge EXE exited before ready (code=${code}, signal=${signal}). ${stderr}`,
    ));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (typeof onNativeOutput === "function") onNativeOutput("stdout", String(chunk));
      if (settled) return;
      pending += chunk;
      if (Buffer.byteLength(pending, "utf8") > 64 * 1024) {
        fail(new Error("CloudCare Electron Bridge EXE startup output is too large."));
        return;
      }
      let newline;
      while (!settled && (newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!line.startsWith("@guance-capabilities")) continue;
        try {
          const capabilities = parseCapabilities(line);
          settled = true;
          cleanup();
          resolve(capabilities);
        } catch (error) {
          fail(new Error(`CloudCare Electron Bridge EXE handshake failed: ${error.message}`));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (typeof onNativeOutput === "function") onNativeOutput("stderr", String(chunk));
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function stopChild(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    child.once("exit", finish);
    if (child.stdin?.writable) child.stdin.end();
    else finish();
  });
}

function createManagedProcessAdapter({
  directory,
  settings,
  readyTimeoutMs = 10_000,
  stopTimeoutMs = 3_000,
  onError,
  onNativeOutput,
} = {}) {
  const nativeDirectory = path.resolve(requiredString(directory, "native.directory"));
  const bridgePath = path.join(nativeDirectory, "guance_windows_electron_bridge.exe");
  const runtimePath = path.join(nativeDirectory, "guance_windows_native.dll");
  const readyLimit = integer(readyTimeoutMs, 10_000, 1, 60_000, "native.readyTimeoutMs");
  const stopLimit = integer(stopTimeoutMs, 3_000, 1, 30_000, "native.stopTimeoutMs");
  let normalized;
  let nativeEnvironment;
  let child;
  let capabilities;
  let stopping = false;
  let stopped;
  let transportFailure;
  let backpressured = false;

  const failTransport = (error) => {
    if (stopping || transportFailure) return;
    transportFailure = error;
    reportError(onError, error);
  };
  const write = (line) => {
    if (transportFailure || backpressured || !child?.stdin?.writable) {
      throw new Error("The CloudCare Electron Bridge EXE is not writable.");
    }
    if (!child.stdin.write(line, "utf8")) backpressured = true;
  };

  return {
    async start() {
      for (const requiredPath of [bridgePath, runtimePath]) {
        if (!fs.existsSync(requiredPath)) {
          throw new Error(`The installed native runtime is missing: ${requiredPath}`);
        }
      }
      ({ normalized, nativeEnvironment } = mapNativeSettings(settings));
      child = spawn(bridgePath, [], {
        cwd: nativeDirectory,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...nativeEnvironment },
      });
      try {
        capabilities = await waitForReady(child, readyLimit, onNativeOutput);
      } catch (error) {
        await stopChild(child, stopLimit);
        throw error;
      }
      child.on("error", failTransport);
      child.on("exit", (code, signal) => failTransport(new Error(
        `CloudCare Electron Bridge EXE exited unexpectedly (code=${code}, signal=${signal}).`,
      )));
      child.stdin.on("error", failTransport);
      child.stdin.on("drain", () => { backpressured = false; });
      return capabilities;
    },
    registerWebContents() {},
    updateWebContents() {},
    sendBrowserEvent(_registration, serializedEvent) {
      const payload = browserBridgeEventToNativeInput(serializedEvent, {
        app_id: normalized.applicationId,
        service: normalized.service,
        env: normalized.environment,
        version: normalized.version,
        sdk_name: "df_windows_rum_sdk",
        is_electron: "true",
      });
      if (payload.measurement === "log" && !normalized.loggingEnabled) {
        throw new Error("Browser Log collection is not enabled in the native settings.");
      }
      if (payload.measurement === "session_replay" && !capabilities.replay) {
        throw new Error("Browser Session Replay is not enabled in the native settings.");
      }
      write(payload.line);
    },
    sendApplicationLaunch(line) {
      write(line);
    },
    unregisterWebContents() {},
    onCommand: inactiveCommandSubscription,
    getState() {
      return Object.freeze({
        writable: Boolean(!transportFailure && !backpressured && child?.stdin?.writable),
        backpressured,
        failure: transportFailure,
      });
    },
    stop() {
      if (!stopped) {
        stopping = true;
        stopped = stopChild(child, stopLimit);
      }
      return stopped;
    },
  };
}

module.exports = {
  createManagedProcessAdapter,
  mapNativeSettings,
};
