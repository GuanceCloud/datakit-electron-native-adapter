"use strict";

const { createClient } = require("../core/client.cjs");
const { createNativeAdapter } = require("../internal/create-native-adapter.cjs");
const { requireObject } = require("../internal/options.cjs");

function loadElectron(electron) {
  if (electron) return requireObject(electron, "electron");
  try {
    return require("electron");
  } catch {
    throw new Error("electron is required; pass the Electron module to bootstrap().");
  }
}

async function bootstrap({
  electron,
  native,
  autoAttach = false,
  enableAppLaunch = true,
  onError,
  onNativeCommand,
} = {}) {
  requireObject(native, "native");
  const adapter = createNativeAdapter(native, onError);
  return createClient({
    electron: loadElectron(electron),
    adapter,
    mode: native.mode,
    autoAttach,
    enableAppLaunch,
    onError,
    onNativeCommand,
  });
}

function startFullMode({
  ipcMain,
  nativeDirectory,
  nativeSettings,
  readyTimeoutMs,
  stopTimeoutMs,
  enableAppLaunch = true,
  onError,
  onNativeOutput,
} = {}) {
  return bootstrap({
    electron: { ipcMain },
    native: {
      mode: "managed",
      directory: nativeDirectory,
      settings: nativeSettings,
      readyTimeoutMs,
      stopTimeoutMs,
      onNativeOutput,
    },
    enableAppLaunch,
    onError,
  });
}

function connectMixedMode({
  ipcMain,
  pipeName,
  timeoutMs,
  retryDelayMs,
  enableAppLaunch = true,
  onError,
} = {}) {
  return bootstrap({
    electron: { ipcMain },
    native: { mode: "external", pipeName, timeoutMs, retryDelayMs },
    enableAppLaunch,
    onError,
  });
}

module.exports = {
  bootstrap,
  connectMixedMode,
  startFullMode,
};
