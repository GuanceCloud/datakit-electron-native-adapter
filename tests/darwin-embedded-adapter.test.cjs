"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  BRIDGE_CHANNEL,
  BRIDGE_CONFIGURATION_CHANNEL,
  MAX_BRIDGE_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} = require("../core/channels.cjs");
const { createClient } = require("../core/client.cjs");
const { createNativeAdapter } = require("../internal/create-native-adapter.cjs");
const { bootstrap } = require("../main/index.cjs");
const {
  createDarwinEmbeddedAdapter,
  parseBridgeConfiguration,
} = require("../platform/darwin/embedded.cjs");

function rumEvent(name = "embedded-action") {
  return JSON.stringify({
    name: "rum",
    data: {
      measurement: "action",
      time: 1_700_000_000_000,
      tags: { action_name: name },
      fields: { duration: 42 },
    },
  });
}

function makeNativeBridge(configuration = {}) {
  const calls = {
    commandHandlers: [],
    receive: [],
    register: [],
    unregister: [],
    update: [],
  };
  return {
    calls,
    getElectronBridgeConfiguration: () => JSON.stringify({
      enableTraceWebView: true,
      allowedWebViewHosts: ["example.com"],
      capabilities: '["records"]',
      privacyLevel: "mask-user-input",
      maximumMessageBytes: MAX_BRIDGE_PAYLOAD_BYTES,
      ...configuration,
    }),
    registerElectronWebContents(...args) {
      calls.register.push(args);
      return true;
    },
    updateElectronWebContents(...args) {
      calls.update.push(args);
      return true;
    },
    receiveElectronWebContentsMessage(...args) {
      calls.receive.push(args);
      return true;
    },
    unregisterElectronWebContents(...args) {
      calls.unregister.push(args);
    },
    setElectronCommandHandler(handler) {
      calls.commandHandlers.push(handler);
    },
  };
}

function makeBrowserWindow(id, url = "https://app.example.com/") {
  const browserWindow = new EventEmitter();
  browserWindow.handle = Buffer.from([1, 2, 3, id]);
  browserWindow.getNativeWindowHandle = () => browserWindow.handle;
  browserWindow.webContents = new EventEmitter();
  browserWindow.webContents.id = id;
  browserWindow.webContents.mainFrame = {};
  browserWindow.webContents.getURL = () => url;
  browserWindow.webContents.isDestroyed = () => false;
  browserWindow.webContents.executedScripts = [];
  browserWindow.webContents.executeJavaScript = async (source) => {
    browserWindow.webContents.executedScripts.push(source);
  };
  return browserWindow;
}

test("maps the macOS bridge configuration to protocol-1 capabilities", () => {
  const parsed = parseBridgeConfiguration(JSON.stringify({
    enableTraceWebView: false,
    allowedWebViewHosts: [" app.example.com "],
    capabilities: '["records"]',
    privacyLevel: "allow",
    maximumMessageBytes: 4096,
  }));

  assert.equal(parsed.autoAttachEnabled, false);
  assert.equal(parsed.maximumMessageBytes, 4096);
  assert.deepEqual(parsed.capabilities, {
    protocolVersion: PROTOCOL_VERSION,
    rum: true,
    log: false,
    replay: true,
    trace: false,
    replayPrivacy: "allow",
    traceSampleRate: 100,
    traceType: "w3c_traceparent",
    allowedWebViewHosts: ["app.example.com"],
  });
  assert.throws(
    () => parseBridgeConfiguration({
      enableTraceWebView: true,
      capabilities: "not-json",
      privacyLevel: "mask",
    }),
    /malformed capabilities JSON/,
  );
});

test("platform routing enables only embedded mode on macOS", () => {
  const bridge = makeNativeBridge();
  const adapter = createNativeAdapter({ mode: "embedded", bridge }, undefined, "darwin");
  assert.equal(typeof adapter.start, "function");
  assert.throws(
    () => createNativeAdapter({ mode: "managed" }, undefined, "darwin"),
    /must be "embedded" on macOS/,
  );
});

test("public bootstrap binds trusted macOS WebContents to the embedded bridge", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS public routing test");
    return;
  }
  const nativeBridge = makeNativeBridge();
  const ipcMain = new EventEmitter();
  const errors = [];
  const commands = [];
  const client = await bootstrap({
    electron: { ipcMain },
    native: { mode: "embedded", bridge: nativeBridge },
    enableAppLaunch: false,
    onError: (error) => errors.push(error),
    onNativeCommand: (command) => commands.push(command),
  });
  const browserWindow = makeBrowserWindow(41);
  const detach = client.attachWindow(browserWindow, {
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    visible: true,
    zIndex: 2,
  });

  assert.equal(client.mode, "embedded");
  assert.deepEqual(client.capabilities.allowedWebViewHosts, ["example.com"]);
  assert.equal(client.transportState.writable, true);
  assert.deepEqual(nativeBridge.calls.register[0].slice(0, 2), [
    browserWindow.handle,
    41,
  ]);
  assert.equal(Number.isSafeInteger(nativeBridge.calls.register[0][2]), true);
  assert.deepEqual(nativeBridge.calls.register[0].slice(3), [
    true,
    2,
    { x: 10, y: 20, width: 800, height: 600 },
  ]);

  const configurationEvent = {
    sender: browserWindow.webContents,
    senderFrame: browserWindow.webContents.mainFrame,
  };
  ipcMain.emit(BRIDGE_CONFIGURATION_CHANNEL, configurationEvent);
  assert.deepEqual(configurationEvent.returnValue, {
    replayEnabled: true,
    replayPrivacy: "mask-user-input",
    allowedWebViewHosts: ["example.com"],
  });

  const serializedEvent = rumEvent();
  ipcMain.emit(BRIDGE_CHANNEL, {
    sender: browserWindow.webContents,
    senderFrame: browserWindow.webContents.mainFrame,
  }, serializedEvent);
  assert.equal(nativeBridge.calls.receive.length, 1);
  assert.equal(nativeBridge.calls.receive[0][0], 41);
  assert.deepEqual(JSON.parse(nativeBridge.calls.receive[0][1]), [
    { handlerName: "sendEvent", data: serializedEvent },
  ]);

  client.updateWindow(browserWindow, {
    visible: false,
    zIndex: 3,
    bounds: { x: 30, y: 40, width: 700, height: 500 },
  });
  assert.deepEqual(nativeBridge.calls.update.at(-1).slice(1), [
    41,
    false,
    3,
    { x: 30, y: 40, width: 700, height: 500 },
  ]);

  browserWindow.webContents.emit(
    "did-start-navigation",
    {},
    "https://blocked.test/",
    false,
    true,
  );
  const receivedBeforeBlockedEvent = nativeBridge.calls.receive.length;
  ipcMain.emit(BRIDGE_CHANNEL, {
    sender: browserWindow.webContents,
    senderFrame: browserWindow.webContents.mainFrame,
  }, rumEvent("blocked"));
  assert.equal(nativeBridge.calls.receive.length, receivedBeforeBlockedEvent);

  nativeBridge.calls.commandHandlers[0](41, "takeSubsequentFullSnapshot");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(browserWindow.webContents.executedScripts, [
    "window.DATAFLUX_RUM?.takeSubsequentFullSnapshot()",
  ]);
  assert.deepEqual(commands, [{
    type: "takeSubsequentFullSnapshot",
    webContentsId: 41,
  }]);
  nativeBridge.calls.commandHandlers[0](41, "takeSubsequentFullSnapshot;alert(1)");
  assert.match(errors.at(-1).message, /invalid command/);

  detach();
  assert.deepEqual(nativeBridge.calls.unregister, [[41]]);
  const firstStop = client.stop();
  const secondStop = client.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.equal(client.transportState.writable, false);
  assert.equal(nativeBridge.calls.commandHandlers.at(-1), null);
  assert.equal(browserWindow.webContents.listenerCount("did-start-navigation"), 0);
});

test("embedded mode rejects unsupported Browser events and native failures", async () => {
  const nativeBridge = makeNativeBridge({
    allowedWebViewHosts: null,
    capabilities: "[]",
    privacyLevel: "allow",
  });
  const adapter = createDarwinEmbeddedAdapter({ bridge: nativeBridge });
  const capabilities = await adapter.start();
  assert.equal(capabilities.replay, false);
  assert.equal(capabilities.replayPrivacy, "mask");

  const browserWindow = makeBrowserWindow(42);
  const registration = {
    webContents: browserWindow.webContents,
    container: browserWindow,
    metadata: {},
  };
  adapter.registerWebContents(registration);
  assert.throws(
    () => adapter.sendBrowserEvent(registration, JSON.stringify({
      name: "log",
      data: { message: "unsupported", status: "info" },
    })),
    /does not support Browser Log/,
  );
  assert.throws(
    () => adapter.sendBrowserEvent(registration, JSON.stringify({
      name: "session_replay",
      view: { id: "view-1" },
      data: { type: 2, timestamp: 1_700_000_000_000, data: {} },
    })),
    /did not enable Browser Session Replay/,
  );

  nativeBridge.receiveElectronWebContentsMessage = () => false;
  assert.throws(
    () => adapter.sendBrowserEvent(registration, rumEvent("rejected")),
    /rejected receiveElectronWebContentsMessage/,
  );
  assert.equal(adapter.getState().writable, false);
  assert.match(adapter.getState().failure.message, /rejected/);
  await adapter.stop();
});

test("native WebView configuration gates automatic but not explicit attachment", async () => {
  const nativeBridge = makeNativeBridge({
    enableTraceWebView: false,
    allowedWebViewHosts: null,
  });
  const adapter = createDarwinEmbeddedAdapter({ bridge: nativeBridge });
  const app = new EventEmitter();
  const existing = makeBrowserWindow(45);
  const client = await createClient({
    electron: {
      ipcMain: new EventEmitter(),
      app,
      BrowserWindow: { getAllWindows: () => [existing] },
    },
    adapter,
    mode: "embedded",
    autoAttach: true,
    enableAppLaunch: false,
  });

  assert.equal(nativeBridge.calls.register.length, 0);
  client.attachWindow(existing);
  assert.equal(nativeBridge.calls.register.length, 1);
  await client.stop();
  assert.equal(app.listenerCount("browser-window-created"), 0);
});

test("BrowserView metadata resolves its host window without exposing a slot", async () => {
  const nativeBridge = makeNativeBridge({ allowedWebViewHosts: null });
  const adapter = createDarwinEmbeddedAdapter({ bridge: nativeBridge });
  await adapter.start();
  const browserWindow = makeBrowserWindow(50);
  const browserView = {
    webContents: makeBrowserWindow(51).webContents,
    getBounds: () => ({ x: 1, y: 2, width: 300, height: 200 }),
  };
  const registration = {
    webContents: browserView.webContents,
    container: browserView,
    metadata: { browserWindow, visible: true, zIndex: 4 },
  };

  adapter.registerWebContents(registration);
  assert.deepEqual(nativeBridge.calls.register[0].slice(0, 2), [
    browserWindow.handle,
    51,
  ]);
  assert.deepEqual(nativeBridge.calls.register[0].slice(3), [
    true,
    4,
    { x: 1, y: 2, width: 300, height: 200 },
  ]);
  assert.equal(Object.hasOwn(registration, "slotId"), false);
  adapter.unregisterWebContents(registration);
  await adapter.stop();
});
