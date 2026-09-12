"use strict";
// Copied into a fresh npm consumer and executed by the requested Electron binary.
const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { bootstrap } = require("@cloudcare/electron-native-adapter");

app.commandLine.appendSwitch("disable-gpu");
app.setPath("userData", path.join(__dirname, "electron-profile"));
const timeout = setTimeout(() => { console.error("Electron runtime smoke timed out"); app.exit(1); }, 30000);
let client;
let window;
let nativeOutput = "";
const errors = [];
app.whenReady().then(async () => {
  client = await bootstrap({ electron: { ipcMain }, enableAppLaunch: false,
    native: { mode: "managed", directory: process.env.GUANCE_TEST_NATIVE_DIRECTORY, settings: {
      applicationId: "windows-electron-acceptance", datakitUrl: "http://127.0.0.1:9",
      service: "local-smoke", environment: "test", version: "0",
      cachePath: path.join(__dirname, "native-cache"), debug: true, httpTimeoutMs: 100,
    }, onNativeOutput(_stream, chunk) { nativeOutput += chunk; } },
    onError(error) { errors.push(error.message); },
  });
  assert.equal(client.capabilities.protocolVersion, 1);
  assert.equal(client.capabilities.rum, true);
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, preload: require.resolve("@cloudcare/electron-native-adapter/preload/standalone") } });
  client.attachWindow(window);
  let received = 0;
  const events = new Promise((resolve) => ipcMain.on("guance:electron-rum:browser-event:v1", () => {
    if (++received === 2) resolve();
  }));
  await window.loadURL("data:text/html,<title>Windows runtime acceptance</title>");
  await window.webContents.executeJavaScript(`
    for (const measurement of ['view', 'action']) {
      window.FTWebViewJavascriptBridge.sendEvent(JSON.stringify({ name: 'rum', data: {
        measurement, time: Date.now(), tags: { view_id: 'electron-smoke', action_name: 'smoke' },
        fields: { duration: 42 }
      } }));
    }
  `);
  await events;
  await client.stop(); client = undefined;
  assert.deepEqual(errors, []);
  assert.match(nativeOutput, /\benqueued=2\b/);
  console.log(JSON.stringify({ passed: true, electron: process.versions.electron, node: process.versions.node,
    checks: "sandboxed Renderer -> Preload -> Main -> staged Bridge EXE, handshake, two events, graceful stop" }));
  clearTimeout(timeout);
  window.destroy(); app.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await client?.stop(); } finally { clearTimeout(timeout); app.exit(1); }
});
