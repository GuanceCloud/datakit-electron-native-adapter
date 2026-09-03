"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createClient } = require("../core/client.cjs");
const { BRIDGE_CHANNEL, PROTOCOL_VERSION } = require("../core/channels.cjs");
const publicApi = require("../main/index.cjs");

const CAPABILITIES = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  rum: true,
  log: true,
  replay: true,
  trace: false,
  replayPrivacy: "mask-user-input",
  traceSampleRate: 100,
  traceType: "w3c_traceparent",
  allowedWebViewHosts: ["app.example.com"],
});

function fakeWebContents() {
  const webContents = new EventEmitter();
  webContents.mainFrame = {};
  webContents.isDestroyed = () => false;
  return webContents;
}

function fakeAdapter(capabilities = CAPABILITIES) {
  const calls = [];
  let commandListener;
  let stopCount = 0;
  return {
    calls,
    get stopCount() { return stopCount; },
    emitCommand(command) { commandListener?.(command); },
    async start() {
      calls.push(["start"]);
      return capabilities;
    },
    registerWebContents(registration) {
      calls.push(["register", registration]);
    },
    updateWebContents(registration, metadata) {
      calls.push(["update", registration, metadata]);
    },
    sendBrowserEvent(registration, payload) {
      calls.push(["event", registration, payload]);
    },
    unregisterWebContents(registration) {
      calls.push(["unregister", registration]);
    },
    onCommand(listener) {
      commandListener = listener;
      calls.push(["command-listener"]);
      return () => {
        commandListener = undefined;
        calls.push(["command-listener-removed"]);
      };
    },
    getState() {
      return { writable: true, backpressured: false };
    },
    async stop() {
      stopCount += 1;
      calls.push(["stop"]);
    },
  };
}

test("public package exposes bootstrap and only supported subpaths", () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "package.json"),
    "utf8",
  ));
  assert.equal(packageJson.name, "@cloudcare/electron-native-adapter");
  assert.equal(packageJson.version, "0.0.0-local");
  assert.equal(packageJson.private, true);
  assert.deepEqual(Object.keys(packageJson.exports), [
    ".",
    "./main",
    "./preload/install",
    "./preload/standalone",
  ]);
  assert.equal(typeof publicApi.bootstrap, "function");
  assert.equal(typeof publicApi.startFullMode, "function");
  assert.equal(typeof publicApi.connectMixedMode, "function");
});

test("common client binds trusted WebContents to the Native Adapter contract", async () => {
  const adapter = fakeAdapter();
  const ipcMain = new EventEmitter();
  const commands = [];
  const client = await createClient({
    electron: { ipcMain },
    adapter,
    mode: "embedded",
    enableAppLaunch: false,
    onNativeCommand: (command) => commands.push(command),
  });
  const trusted = fakeWebContents();
  const untrusted = fakeWebContents();
  const detach = client.attachWindow(trusted, { visible: true });
  client.updateWindow(trusted, { width: 800, height: 600 });

  ipcMain.emit(BRIDGE_CHANNEL, {
    sender: untrusted,
    senderFrame: untrusted.mainFrame,
  }, "untrusted");
  ipcMain.emit(BRIDGE_CHANNEL, {
    sender: trusted,
    senderFrame: trusted.mainFrame,
  }, "trusted");
  adapter.emitCommand({ type: "refresh-layout" });

  assert.equal(client.mode, "embedded");
  assert.equal(client.capabilities.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(client.capabilities.allowedWebViewHosts, ["app.example.com"]);
  assert.equal(adapter.calls.filter(([name]) => name === "register").length, 1);
  assert.equal(adapter.calls.filter(([name]) => name === "event").length, 1);
  assert.equal(adapter.calls.find(([name]) => name === "event")[2], "trusted");
  assert.deepEqual(adapter.calls.find(([name]) => name === "update")[2], {
    visible: true,
    width: 800,
    height: 600,
  });
  assert.deepEqual(commands, [{ type: "refresh-layout" }]);

  detach();
  const firstStop = client.stop();
  const secondStop = client.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.equal(adapter.stopCount, 1);
  assert.equal(ipcMain.listenerCount(BRIDGE_CHANNEL), 0);
  assert.equal(adapter.calls.filter(([name]) => name === "unregister").length, 1);
  assert.equal(adapter.calls.filter(([name]) => name === "command-listener-removed").length, 1);
});

test("malformed capabilities are rejected before IPC registration", async () => {
  const adapter = fakeAdapter({ ...CAPABILITIES, replay: "yes" });
  const ipcMain = new EventEmitter();
  await assert.rejects(
    createClient({
      electron: { ipcMain },
      adapter,
      mode: "embedded",
      enableAppLaunch: false,
    }),
    /capability replay must be a boolean/,
  );
  assert.equal(adapter.stopCount, 1);
  assert.equal(ipcMain.listenerCount(BRIDGE_CHANNEL), 0);
});

test("autoAttach tracks existing and newly-created windows and cleans up", async () => {
  const adapter = fakeAdapter();
  const ipcMain = new EventEmitter();
  const app = new EventEmitter();
  const existing = { webContents: fakeWebContents() };
  const created = { webContents: fakeWebContents() };
  const client = await createClient({
    electron: {
      ipcMain,
      app,
      BrowserWindow: { getAllWindows: () => [existing] },
    },
    adapter,
    mode: "embedded",
    autoAttach: true,
    enableAppLaunch: false,
  });
  app.emit("browser-window-created", {}, created);
  assert.equal(adapter.calls.filter(([name]) => name === "register").length, 2);
  await client.stop();
  assert.equal(app.listenerCount("browser-window-created"), 0);
  assert.equal(adapter.calls.filter(([name]) => name === "unregister").length, 2);
});
