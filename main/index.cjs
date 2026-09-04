"use strict";

const { createClient } = require("../core/client.cjs");
const { createDarwinAdapter } = require("../platform/darwin/index.cjs");
const { createWindowsAdapter } = require("../platform/win32/index.cjs");
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
  const electronModule = loadElectron(electron);
  let adapter;
  let mode = native.mode;
  if (process.platform === "win32") {
    adapter = createWindowsAdapter(native, onError);
  } else if (process.platform === "darwin") {
    adapter = createDarwinAdapter(native, electronModule, onError);
  } else {
    throw new Error(`Electron Native Adapter does not yet support ${process.platform}.`);
  }
  return createClient({
    electron: electronModule,
    adapter,
    mode,
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
  electron,
  ipcMain,
  pipeName,
  timeoutMs,
  retryDelayMs,
  socketPath,
  authenticationToken,
  protocolVersion,
  environment,
  connectTimeoutMs,
  enableAppLaunch = true,
  onError,
} = {}) {
  const electronModule = electron || ipcMain
    ? { ...(electron || {}), ipcMain: ipcMain || electron?.ipcMain }
    : undefined;
  return bootstrap({
    electron: electronModule,
    native: {
      mode: "external",
      pipeName,
      timeoutMs,
      retryDelayMs,
      socketPath,
      authenticationToken,
      protocolVersion,
      environment,
      connectTimeoutMs,
    },
    enableAppLaunch,
    onError,
  });
}

module.exports = {
  bootstrap,
  connectMixedMode,
  startFullMode,
};
