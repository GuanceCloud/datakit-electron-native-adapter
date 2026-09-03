"use strict";

const {
  BRIDGE_CHANNEL,
  BRIDGE_CONFIGURATION_CHANNEL,
} = require("./channels.cjs");
const { rendererConfiguration } = require("./capabilities.cjs");
const { browserRumViewContext } = require("../internal/rum-line-protocol.cjs");
const { reportError } = require("../internal/options.cjs");

const ipcOwners = new WeakMap();

function resolveWebContents(windowOrWebContents) {
  const webContents = windowOrWebContents?.webContents || windowOrWebContents;
  if (!webContents || typeof webContents !== "object" || !webContents.mainFrame) {
    throw new Error("attachWindow requires an Electron BrowserWindow or WebContents.");
  }
  return webContents;
}

function createElectronIpc({ ipcMain, adapter, capabilities, launchTracker, onError }) {
  if (!ipcMain || typeof ipcMain.on !== "function" ||
      typeof ipcMain.removeListener !== "function") {
    throw new Error("electron.ipcMain must provide on() and removeListener().");
  }
  if (ipcOwners.has(ipcMain)) {
    throw new Error("The CloudCare Electron RUM IPC channel is already registered.");
  }

  const registrations = new Map();
  const configuration = rendererConfiguration(capabilities);
  const isTrustedMainFrame = (event) => {
    const sender = event?.sender;
    return registrations.has(sender) &&
      !(typeof sender?.isDestroyed === "function" && sender.isDestroyed()) &&
      event.senderFrame === sender?.mainFrame;
  };
  const browserEventHandler = (event, serializedEvent) => {
    if (!isTrustedMainFrame(event)) return;
    const registration = registrations.get(event.sender);
    try {
      adapter.sendBrowserEvent(registration, serializedEvent);
    } catch (error) {
      reportError(onError, error);
      return;
    }
    if (launchTracker) {
      try {
        const view = browserRumViewContext(serializedEvent);
        if (view) launchTracker.observeTrustedView(event.sender, view);
      } catch (error) {
        reportError(onError, error);
      }
    }
  };
  const configurationHandler = (event) => {
    event.returnValue = isTrustedMainFrame(event)
      ? configuration
      : { replayEnabled: false, replayPrivacy: "mask" };
  };
  const owner = { browserEventHandler, configurationHandler };
  ipcOwners.set(ipcMain, owner);
  ipcMain.on(BRIDGE_CHANNEL, browserEventHandler);
  ipcMain.on(BRIDGE_CONFIGURATION_CHANNEL, configurationHandler);

  function attachWindow(windowOrWebContents, metadata = {}) {
    const webContents = resolveWebContents(windowOrWebContents);
    const existing = registrations.get(webContents);
    if (existing) return existing.detach;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("Window metadata must be an object.");
    }
    const registration = { webContents, container: windowOrWebContents, metadata: { ...metadata } };
    adapter.registerWebContents(registration);
    let detachLaunch;
    let destroyedHandler;
    try {
      detachLaunch = launchTracker?.attachWindow(windowOrWebContents);
      const detach = () => {
        if (!registrations.delete(webContents)) return;
        if (destroyedHandler && typeof webContents.removeListener === "function") {
          webContents.removeListener("destroyed", destroyedHandler);
        }
        detachLaunch?.();
        try {
          adapter.unregisterWebContents(registration);
        } catch (error) {
          reportError(onError, error);
        }
      };
      registration.detach = detach;
      registrations.set(webContents, registration);
      if (typeof webContents.once === "function") {
        destroyedHandler = detach;
        webContents.once("destroyed", destroyedHandler);
      }
      return detach;
    } catch (error) {
      adapter.unregisterWebContents(registration);
      throw error;
    }
  }

  function detachWindow(windowOrWebContents) {
    const webContents = resolveWebContents(windowOrWebContents);
    registrations.get(webContents)?.detach();
  }

  function updateWindow(windowOrWebContents, metadata) {
    const webContents = resolveWebContents(windowOrWebContents);
    const registration = registrations.get(webContents);
    if (!registration) throw new Error("The Electron BrowserWindow or WebContents is not attached.");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("Window metadata must be an object.");
    }
    registration.metadata = { ...registration.metadata, ...metadata };
    adapter.updateWebContents(registration, registration.metadata);
  }

  return {
    attachWindow,
    detachWindow,
    updateWindow,
    dispose() {
      for (const registration of [...registrations.values()]) {
        try {
          registration.detach();
        } catch (error) {
          reportError(onError, error);
        }
      }
      try {
        launchTracker?.dispose();
      } catch (error) {
        reportError(onError, error);
      }
      ipcMain.removeListener(BRIDGE_CHANNEL, browserEventHandler);
      ipcMain.removeListener(BRIDGE_CONFIGURATION_CHANNEL, configurationHandler);
      if (ipcOwners.get(ipcMain) === owner) ipcOwners.delete(ipcMain);
    },
  };
}

module.exports = { createElectronIpc };
