"use strict";

const { normalizeCapabilities } = require("./capabilities.cjs");
const { createElectronIpc } = require("./electron-ipc.cjs");
const { ElectronApplicationLaunchTracker } = require("./application-launch.cjs");
const { electronLaunchToNativeInput } = require("../internal/rum-line-protocol.cjs");
const { assertNativeAdapter } = require("../internal/native-adapter.cjs");
const { boolean, reportError } = require("../internal/options.cjs");

async function createClient({
  electron,
  adapter,
  mode,
  autoAttach = false,
  enableAppLaunch = true,
  onError,
  onNativeCommand,
}) {
  assertNativeAdapter(adapter);
  if (!electron || typeof electron !== "object") throw new Error("electron is required.");
  const attachAutomatically = boolean(autoAttach, false, "autoAttach");
  const launchEnabled = boolean(enableAppLaunch, true, "enableAppLaunch");
  let capabilities;
  try {
    capabilities = normalizeCapabilities(await adapter.start());
  } catch (error) {
    await adapter.stop();
    throw error;
  }

  const launchTracker = launchEnabled && typeof adapter.sendApplicationLaunch === "function"
    ? new ElectronApplicationLaunchTracker({
        onError: (error) => reportError(onError, error),
        sendLaunch: (launch, view) => adapter.sendApplicationLaunch(
          electronLaunchToNativeInput(launch, view),
        ),
      })
    : undefined;
  let ipc;
  let removeAutoAttach = () => {};
  let removeCommandListener = () => {};
  try {
    ipc = createElectronIpc({
      ipcMain: electron.ipcMain,
      adapter,
      capabilities,
      launchTracker,
      onError,
    });
    removeCommandListener = adapter.onCommand((command) => {
      if (typeof onNativeCommand !== "function") return;
      try {
        onNativeCommand(command);
      } catch (error) {
        reportError(onError, error);
      }
    });
    if (attachAutomatically && adapter.autoAttachEnabled !== false) {
      const { app, BrowserWindow } = electron;
      if (typeof app?.on !== "function" || typeof app?.removeListener !== "function" ||
          typeof BrowserWindow?.getAllWindows !== "function") {
        throw new Error("autoAttach requires electron.app and electron.BrowserWindow.");
      }
      for (const window of BrowserWindow.getAllWindows()) ipc.attachWindow(window);
      const handleWindowCreated = (_event, window) => {
        try {
          ipc.attachWindow(window);
        } catch (error) {
          reportError(onError, error);
        }
      };
      app.on("browser-window-created", handleWindowCreated);
      removeAutoAttach = () => app.removeListener("browser-window-created", handleWindowCreated);
    }
  } catch (error) {
    removeCommandListener?.();
    ipc?.dispose();
    launchTracker?.dispose();
    await adapter.stop();
    throw error;
  }

  let stopped;
  return Object.freeze({
    mode,
    capabilities,
    attachWindow: ipc.attachWindow,
    detachWindow: ipc.detachWindow,
    updateWindow: ipc.updateWindow,
    get transportState() {
      return adapter.getState();
    },
    stop() {
      if (!stopped) {
        stopped = (async () => {
          let firstError;
          const cleanup = (operation) => {
            try {
              operation();
            } catch (error) {
              firstError ||= error;
              reportError(onError, error);
            }
          };
          cleanup(removeAutoAttach);
          cleanup(() => removeCommandListener?.());
          cleanup(() => ipc.dispose());
          try {
            await adapter.stop();
          } catch (error) {
            firstError ||= error;
          }
          if (firstError) {
            throw firstError;
          }
        })();
      }
      return stopped;
    },
  });
}

module.exports = { createClient };
