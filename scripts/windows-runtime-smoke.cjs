"use strict";

// Copied into a fresh tarball consumer; no source checkout imports are allowed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { bootstrap, startFullMode } = require("@cloudcare/electron-native-adapter");

async function main() {
  for (const api of ["bootstrap", "startFullMode", "explicitOverride"]) {
    const ipcMain = new EventEmitter();
    let output = "";
    const errors = [];
    const settings = {
      applicationId: "npm-tarball-smoke", datakitUrl: "http://127.0.0.1:9",
      service: "npm-smoke", environment: "test", version: "0",
      cachePath: fs.mkdtempSync(path.join(os.tmpdir(), "npm-runtime-smoke-")),
      loggingEnabled: true, replayEnabled: true, replaySampleRate: 1,
      debug: true, httpTimeoutMs: 100,
    };
    const onNativeOutput = (_stream, chunk) => { output += chunk; };
    const onError = (error) => errors.push(error);
    const bridge = await (api === "bootstrap"
      ? bootstrap({ electron: { ipcMain }, native: { mode: "managed", settings, onNativeOutput }, onError, enableAppLaunch: false })
      : startFullMode({ ipcMain, nativeSettings: settings, onNativeOutput, onError, enableAppLaunch: false,
        nativeDirectory: api === "explicitOverride" ? (process.env.GUANCE_TEST_NATIVE_DIRECTORY ||
          path.join(path.dirname(require.resolve("@cloudcare/electron-native-adapter-win32-x64/package.json")), "runtime")) : undefined,
      }));
    try {
      assert.equal(bridge.capabilities.protocolVersion, 1);
      assert.equal(bridge.capabilities.rum, true);
      const webContents = new EventEmitter();
      webContents.mainFrame = {};
      webContents.isDestroyed = () => false;
      bridge.attachWindow(webContents);
      for (const measurement of ["view", "action"]) {
        ipcMain.emit("guance:electron-rum:browser-event:v1", { sender: webContents, senderFrame: webContents.mainFrame }, JSON.stringify({
          name: "rum", data: { measurement, time: Date.now(), tags: { view_id: "npm-smoke", action_name: "npm-action" }, fields: { duration: 42 } },
        }));
      }
    } finally { await bridge.stop(); }
    assert.deepEqual(errors, []);
    assert.match(output, /\benqueued=2\b/);
    assert.doesNotMatch(output, /rejected invalid bridge input/);
    console.log(`PASS ${api}: runtime resolution, capabilities, view/action events, graceful stop`);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
