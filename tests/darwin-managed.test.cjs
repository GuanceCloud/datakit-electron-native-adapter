"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { PROTOCOL_VERSION } = require("../core/channels.cjs");
const { normalizeNativeSettings } = require("../internal/native-settings.cjs");
const { bootstrap } = require("../main/index.cjs");
const {
  createManagedAdapter,
  nativeConfigurations,
  nativeSampling,
  nativeTraceType,
  parseBridgeConfiguration,
  sessionReplayPrivacy,
} = require("../platform/darwin/managed.cjs");

function settings(overrides = {}) {
  return {
    applicationId: "electron-app",
    datakitUrl: "http://127.0.0.1:9529",
    service: "desktop-app",
    environment: "production",
    version: "1.0.0",
    sampleRate: 0.75,
    loggingEnabled: true,
    loggingSampleRate: 0.5,
    replayEnabled: true,
    replaySampleRate: 0.25,
    replayPrivacy: "mask-user-input",
    traceEnabled: true,
    traceSampleRate: 0.8,
    traceType: "w3c_traceparent",
    ...overrides,
  };
}

function rumEvent() {
  return JSON.stringify({
    name: "rum",
    data: {
      measurement: "view",
      time: 1_700_000_000_000,
      tags: { view_id: "mac-view", view_name: "macOS" },
      fields: { time_spent: 1 },
    },
  });
}

function logEvent() {
  return JSON.stringify({
    name: "log",
    data: { message: "Browser warning", status: "warn", source: "renderer" },
  });
}

function replayEvent() {
  return JSON.stringify({
    name: "session_replay",
    data: { type: 2, timestamp: 1_700_000_000_000, records: [] },
    view: { id: "mac-view" },
  });
}

class FakeBinding {
  constructor(configuration = {}) {
    this.configuration = {
      enableTraceWebView: true,
      enableWebViewLog: true,
      allowedWebViewHosts: ["example.com"],
      maximumMessageBytes: 1024 * 1024,
      capabilities: '["records"]',
      privacyLevel: "mask-user-input",
      ...configuration,
    };
    this.invocations = [];
    this.registrations = [];
    this.updates = [];
    this.messages = [];
    this.unregistered = [];
    this.commandHandlers = [];
  }

  async invoke(method, payload) {
    this.invocations.push({ method, payload: JSON.parse(payload) });
    return "{}";
  }

  getElectronBridgeConfiguration() {
    return JSON.stringify(this.configuration);
  }

  registerElectronWebContents(handle, webContentsId, slotId, visible, zIndex, bounds) {
    this.registrations.push({ handle, webContentsId, slotId, visible, zIndex, bounds });
    return true;
  }

  updateElectronWebContents(handle, webContentsId, visible, zIndex, bounds) {
    this.updates.push({ handle, webContentsId, visible, zIndex, bounds });
    return true;
  }

  receiveElectronWebContentsMessage(webContentsId, message) {
    this.messages.push({ webContentsId, message });
    return true;
  }

  unregisterElectronWebContents(webContentsId) {
    this.unregistered.push(webContentsId);
  }

  setElectronCommandHandler(handler) {
    this.commandHandler = handler;
    this.commandHandlers.push(handler);
  }
}

function fakeWindow(id = 41) {
  const webContents = new EventEmitter();
  webContents.id = id;
  webContents.mainFrame = {};
  webContents.url = "https://app.example.com/";
  webContents.getURL = () => webContents.url;
  webContents.isDestroyed = () => false;
  webContents.executedScripts = [];
  webContents.executeJavaScript = (script) => {
    webContents.executedScripts.push(script);
    return Promise.resolve();
  };
  const window = new EventEmitter();
  window.webContents = webContents;
  window.getNativeWindowHandle = () => Buffer.alloc(8, 1);
  return window;
}

test("macOS settings map to the existing Native API without changing public units", () => {
  const mapped = nativeConfigurations(normalizeNativeSettings(settings()));
  assert.equal(nativeSampling(0), 0);
  assert.equal(nativeSampling(0.755), 76);
  assert.equal(nativeSampling(1), 100);
  for (const [publicType, nativeType] of Object.entries({
    ddtrace: "ddTrace",
    zipkin: "zipkinMulti",
    zipkin_multi: "zipkinMulti",
    zipkin_single_header: "zipkinSingle",
    w3c_traceparent: "traceparent",
    skywalking_v3: "skywalking",
    jaeger: "jaeger",
  })) {
    assert.equal(nativeTraceType(publicType), nativeType);
  }
  assert.deepEqual(sessionReplayPrivacy("allow"), {
    touchPrivacy: "show",
    textAndInputPrivacy: "maskSensitiveInputs",
    imagePrivacy: "maskNone",
  });
  assert.deepEqual(sessionReplayPrivacy("mask-user-input"), {
    touchPrivacy: "show",
    textAndInputPrivacy: "maskAllInputs",
    imagePrivacy: "maskNonBundledOnly",
  });
  assert.deepEqual(sessionReplayPrivacy("mask"), {
    touchPrivacy: "hide",
    textAndInputPrivacy: "maskAll",
    imagePrivacy: "maskAll",
  });
  assert.deepEqual(mapped.sdk, {
    datakitUrl: "http://127.0.0.1:9529",
    env: "production",
    service: "desktop-app",
    debug: false,
    version: "1.0.0",
    cachePath: "",
    httpTimeoutMs: 10_000,
  });
  assert.deepEqual(mapped.rum, {
    appId: "electron-app",
    sampleRate: 75,
    enableTraceWebView: true,
  });
  const removedActionSetting = normalizeNativeSettings(settings({
    actionTrackingEnabled: true,
  }));
  assert.equal("actionTrackingEnabled" in removedActionSetting, false);
  assert.equal(
    "enableTraceUserAction" in nativeConfigurations(removedActionSetting).rum,
    false,
  );
  assert.deepEqual(mapped.logger, {
    sampleRate: 50,
    enableCustomLog: true,
    enableWebViewLog: true,
    enableLinkRumData: true,
  });
  assert.deepEqual(mapped.trace, {
    sampleRate: 80,
    traceType: "traceparent",
    enableAutoTrace: true,
    enableLinkRumData: true,
  });
  assert.deepEqual(mapped.replay, {
    sampleRate: 25,
    touchPrivacy: "show",
    textAndInputPrivacy: "maskAllInputs",
    imagePrivacy: "maskNonBundledOnly",
  });
  assert.deepEqual(
    nativeConfigurations(normalizeNativeSettings(settings({
      datakitUrl: "",
      datawayUrl: "https://dataway.example.com",
      clientToken: " token ",
    }))).sdk,
    {
      datawayUrl: "https://dataway.example.com",
      clientToken: "token",
      env: "production",
      service: "desktop-app",
      debug: false,
      version: "1.0.0",
      cachePath: "",
      httpTimeoutMs: 10_000,
    },
  );
  assert.throws(
    () => nativeConfigurations(normalizeNativeSettings(settings({
      datakitUrl: "",
      datawayUrl: "https://dataway.example.com",
      clientToken: " ",
    }))),
    /clientToken is required/,
  );
});

test("macOS bridge configuration is validated and normalized", () => {
  const configuration = parseBridgeConfiguration(JSON.stringify({
    enableTraceWebView: true,
    enableWebViewLog: true,
    allowedWebViewHosts: [" example.com "],
    maximumMessageBytes: 4096,
    capabilities: '["records"]',
    privacyLevel: "allow",
  }));
  assert.deepEqual(configuration.allowedWebViewHosts, ["example.com"]);
  assert.equal(configuration.enableWebViewLog, true);
  assert.deepEqual(configuration.capabilities, ["records"]);
  assert.equal(configuration.privacyLevel, "allow");
  assert.throws(
    () => parseBridgeConfiguration({ enableTraceWebView: true, capabilities: "{" }),
    /capabilities are not valid JSON/,
  );
});

test("macOS managed adapter owns Native startup, Browser forwarding, and shutdown", async () => {
  const binding = new FakeBinding();
  const nativeCommands = [];
  const adapter = createManagedAdapter({ settings: settings(), binding });
  const capabilities = await adapter.start();
  const expected = nativeConfigurations(normalizeNativeSettings(settings()));
  assert.deepEqual(binding.invocations, [
    { method: "sdk.initialize", payload: expected.sdk },
    { method: "rum.configure", payload: expected.rum },
    { method: "logger.configure", payload: expected.logger },
    { method: "trace.configure", payload: expected.trace },
    { method: "sessionReplay.configure", payload: expected.replay },
  ]);
  assert.deepEqual(capabilities, {
    protocolVersion: PROTOCOL_VERSION,
    rum: true,
    log: true,
    replay: true,
    trace: true,
    replayPrivacy: "mask-user-input",
    traceSampleRate: 80,
    traceType: "w3c_traceparent",
    allowedWebViewHosts: ["example.com"],
  });

  const window = fakeWindow();
  const registration = {
    webContents: window.webContents,
    container: window,
    metadata: { visible: true, zIndex: 2, bounds: { x: 0, y: 0, width: 800, height: 600 } },
  };
  adapter.registerWebContents(registration);
  adapter.onCommand((command) => nativeCommands.push(command));
  adapter.sendBrowserEvent(registration, rumEvent());
  adapter.sendBrowserEvent(registration, replayEvent());
  adapter.sendBrowserEvent(registration, logEvent());

  assert.equal(binding.registrations.length, 1);
  assert.equal(binding.registrations[0].visible, true);
  assert.ok(Number.isSafeInteger(binding.registrations[0].slotId));
  assert.deepEqual(JSON.parse(binding.messages[0].message), [
    { handlerName: "sendEvent", data: rumEvent() },
  ]);
  assert.deepEqual(JSON.parse(binding.messages[1].message), [
    { handlerName: "sendEvent", data: replayEvent() },
  ]);
  assert.deepEqual(JSON.parse(binding.messages[2].message), [
    { handlerName: "sendEvent", data: logEvent() },
  ]);
  assert.equal(
    binding.invocations.some(({ method }) => method === "logger.log"),
    false,
  );

  binding.commandHandler(41, "takeSubsequentFullSnapshot");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(window.webContents.executedScripts, [
    "window.DATAFLUX_RUM?.takeSubsequentFullSnapshot()",
  ]);
  assert.deepEqual(nativeCommands, [
    { type: "takeSubsequentFullSnapshot", webContentsId: 41 },
  ]);

  window.webContents.emit("did-start-navigation", {}, "https://blocked.invalid/", false, true);
  assert.equal(binding.updates.at(-1).visible, false);
  adapter.sendBrowserEvent(registration, rumEvent());
  assert.equal(binding.messages.length, 3);

  adapter.updateWebContents(registration, { visible: false, zIndex: 3 });
  assert.equal(binding.updates.at(-1).zIndex, 3);
  adapter.unregisterWebContents(registration);
  assert.deepEqual(binding.unregistered, [41]);

  const firstStop = adapter.stop();
  const secondStop = adapter.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.equal(binding.invocations.filter(({ method }) => method === "sdk.shutdown").length, 1);
  assert.equal(adapter.getState().writable, false);
  assert.equal(binding.commandHandlers.at(-1), null);
});

test("macOS managed feature flags control optional Native configuration", async () => {
  const binding = new FakeBinding();
  const adapter = createManagedAdapter({
    settings: settings({
      loggingEnabled: false,
      replayEnabled: false,
      traceEnabled: false,
    }),
    binding,
  });
  const capabilities = await adapter.start();

  assert.deepEqual(binding.invocations.map(({ method }) => method), [
    "sdk.initialize",
    "rum.configure",
  ]);
  assert.equal("enableTraceUserAction" in binding.invocations[1].payload, false);
  assert.equal(capabilities.log, false);
  assert.equal(capabilities.replay, false);
  assert.equal(capabilities.trace, false);

  await adapter.stop();
});

test("public bootstrap selects macOS managed Full Mode and preserves the client", {
  skip: process.platform !== "darwin",
}, async () => {
  const binding = new FakeBinding({ allowedWebViewHosts: null });
  const ipcMain = new EventEmitter();
  const client = await bootstrap({
    electron: { ipcMain },
    native: { mode: "managed", settings: settings(), binding },
    enableAppLaunch: false,
  });
  assert.equal(client.mode, "managed");
  assert.equal(client.capabilities.rum, true);
  assert.equal(client.transportState.writable, true);
  await client.stop();
  assert.equal(client.transportState.writable, false);
});

test("public bootstrap rejects embedded mode on macOS", {
  skip: process.platform !== "darwin",
}, async () => {
  await assert.rejects(
    bootstrap({
      electron: { ipcMain: new EventEmitter() },
      native: { mode: "embedded", settings: settings(), binding: new FakeBinding() },
      enableAppLaunch: false,
    }),
    /must be "managed" or "external"/,
  );
});

test("macOS managed startup fails closed and shuts down a partially initialized SDK", async () => {
  const binding = new FakeBinding({ enableTraceWebView: false });
  const errors = [];
  const adapter = createManagedAdapter({
    settings: settings({ loggingEnabled: false, traceEnabled: false, replayEnabled: false }),
    binding,
    onError: (error) => errors.push(error),
  });
  await assert.rejects(adapter.start(), /WebView bridge is disabled/);
  assert.equal(binding.invocations.at(-1).method, "sdk.shutdown");
  assert.equal(adapter.getState().writable, false);
  await adapter.stop();
  assert.deepEqual(errors, []);
});

test("macOS managed startup requires the Native Browser Log bridge when logging is enabled", async () => {
  const binding = new FakeBinding({ enableWebViewLog: false });
  const adapter = createManagedAdapter({ settings: settings(), binding });

  await assert.rejects(adapter.start(), /Native Browser Log bridge is disabled/);
  assert.equal(binding.invocations.at(-1).method, "sdk.shutdown");
  assert.equal(adapter.getState().writable, false);
  await adapter.stop();
});
