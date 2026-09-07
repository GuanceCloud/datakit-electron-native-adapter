"use strict";

const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BRIDGE_CHANNEL, PROTOCOL_VERSION } = require("../core/channels.cjs");
const { connectMixedMode } = require("../main/index.cjs");
const {
  MIXED_MODE_ENVIRONMENT,
  createExternalSocketAdapter,
  resolveCredentials,
} = require("../platform/darwin/external-socket.cjs");

function rumEvent() {
  return JSON.stringify({
    name: "rum",
    data: {
      measurement: "view",
      time: 1_700_000_000_000,
      tags: { view_id: "mixed-view", view_name: "Mixed" },
      fields: { time_spent: 1 },
    },
  });
}

function replayEvent() {
  return JSON.stringify({
    name: "session_replay",
    data: { type: 2, timestamp: 1_700_000_000_100, records: [] },
    view: { id: "mixed-view" },
  });
}

function logEvent() {
  return JSON.stringify({
    name: "log",
    data: { message: "not supported", status: "warn" },
  });
}

function fakeWindow(id = 301) {
  const webContents = new EventEmitter();
  webContents.id = id;
  webContents.mainFrame = {};
  webContents.url = "https://app.example.com/";
  webContents.getURL = () => webContents.url;
  webContents.isDestroyed = () => false;
  webContents.executedScripts = [];
  webContents.executeJavaScript = async (script) => {
    webContents.executedScripts.push(script);
  };
  const window = new EventEmitter();
  window.webContents = webContents;
  window.getNativeWindowHandle = () => {
    throw new Error("Mixed Mode must not request a native window handle.");
  };
  return window;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the Mixed Mode protocol.");
}

async function createProtocolServer(token, configuration = {}, { sendReady = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guance-adapter-mixed-"));
  const socketPath = path.join(directory, "bridge.sock");
  const messages = [];
  let activeSocket;
  let connectionID;
  let input = Buffer.alloc(0);
  const send = (message) => {
    if (activeSocket?.writable && !activeSocket.destroyed) {
      activeSocket.write(`${JSON.stringify(message)}\n`);
    }
  };
  const server = net.createServer((socket) => {
    activeSocket = socket;
    socket.on("error", () => {});
    socket.on("data", (data) => {
      input = Buffer.concat([input, data]);
      while (true) {
        const newline = input.indexOf(0x0a);
        if (newline < 0) return;
        const message = JSON.parse(input.subarray(0, newline).toString("utf8"));
        input = input.subarray(newline + 1);
        messages.push(message);
        if (message.type === "hello") {
          if (message.protocolVersion !== PROTOCOL_VERSION ||
              message.authenticationToken !== token) {
            socket.destroy();
            return;
          }
          connectionID = message.connectionID;
          if (!sendReady) continue;
          send({
            protocolVersion: PROTOCOL_VERSION,
            type: "ready",
            connectionID,
            configuration: {
              enableTraceWebView: true,
              allowedWebViewHosts: ["example.com"],
              maximumMessageBytes: 1024 * 1024,
              capabilities: '["records"]',
              privacyLevel: "mask-user-input",
              ...configuration,
            },
          });
          continue;
        }
        send({
          protocolVersion: PROTOCOL_VERSION,
          type: "ack",
          connectionID,
          sequence: message.sequence,
          requestID: message.requestID,
          ok: true,
          ...(message.type === "register" ? { slotID: 7001 } : {}),
        });
        if (message.type === "close") socket.end();
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    messages,
    socketPath,
    sendCommand(webContentsID, command) {
      send({
        protocolVersion: PROTOCOL_VERSION,
        type: "command",
        connectionID,
        webContentsID,
        command,
      });
    },
    async close() {
      activeSocket?.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("macOS Mixed Mode resolves only Native-host credentials", () => {
  const environment = {
    [MIXED_MODE_ENVIRONMENT.socketPath]: "/tmp/native-owned.sock",
    [MIXED_MODE_ENVIRONMENT.authenticationToken]: "native-token",
    [MIXED_MODE_ENVIRONMENT.protocolVersion]: "1",
  };
  assert.deepEqual(resolveCredentials({ environment }), {
    socketPath: "/tmp/native-owned.sock",
    authenticationToken: "native-token",
  });
  assert.throws(() => resolveCredentials({ environment: {} }), /socket path is required/);
  assert.throws(
    () => resolveCredentials({ environment: { ...environment,
      [MIXED_MODE_ENVIRONMENT.protocolVersion]: "2" } }),
    /Unsupported Native Electron Bridge protocol 2/,
  );
});

test("macOS Mixed Mode authenticates, routes windows and events, and closes", {
  skip: process.platform !== "darwin",
}, async () => {
  const token = "native-generated-token";
  const protocol = await createProtocolServer(token);
  const ipcMain = new EventEmitter();
  const commands = [];
  let client;
  try {
    client = await connectMixedMode({
      electron: { ipcMain },
      environment: {
        [MIXED_MODE_ENVIRONMENT.socketPath]: protocol.socketPath,
        [MIXED_MODE_ENVIRONMENT.authenticationToken]: token,
        [MIXED_MODE_ENVIRONMENT.protocolVersion]: "1",
      },
      connectTimeoutMs: 1_000,
      enableAppLaunch: false,
      onError: (error) => { throw error; },
    });
    assert.equal(client.mode, "external");
    assert.deepEqual(client.capabilities, {
      protocolVersion: PROTOCOL_VERSION,
      rum: true,
      log: false,
      replay: true,
      trace: false,
      replayPrivacy: "mask-user-input",
      traceSampleRate: 0,
      traceType: "w3c_traceparent",
      allowedWebViewHosts: ["example.com"],
    });

    const window = fakeWindow();
    const detach = client.attachWindow(window, { visible: true });
    await waitFor(() => protocol.messages.some(
      (message) => message.type === "register" && message.webContentsID === 301,
    ));
    ipcMain.emit(BRIDGE_CHANNEL, {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    }, rumEvent());
    ipcMain.emit(BRIDGE_CHANNEL, {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    }, replayEvent());
    await waitFor(() => protocol.messages.filter((message) => message.type === "event").length === 2);
    assert.deepEqual(JSON.parse(
      protocol.messages.find((message) => message.type === "event").payload,
    ), [{ handlerName: "sendEvent", data: rumEvent() }]);

    protocol.sendCommand(301, "takeSubsequentFullSnapshot");
    await waitFor(() => window.webContents.executedScripts.length === 1);
    assert.equal(
      window.webContents.executedScripts[0],
      "window.DATAFLUX_RUM?.takeSubsequentFullSnapshot()",
    );
    client.updateWindow(window, { visible: false });
    window.webContents.url = "https://blocked.invalid/";
    window.webContents.emit(
      "did-start-navigation", {}, window.webContents.url, false, true,
    );
    await waitFor(() => protocol.messages.filter((message) => message.type === "update").length === 2);
    assert.equal(protocol.messages.filter((message) => message.type === "update").at(-1).visible, false);

    detach();
    const firstStop = client.stop();
    const secondStop = client.stop();
    assert.equal(firstStop, secondStop);
    await firstStop;
    await waitFor(() => protocol.messages.some((message) => message.type === "close"));
    assert.equal(client.transportState.writable, false);
  } finally {
    await client?.stop();
    await protocol.close();
  }
});

test("macOS Mixed Mode validates Browser events and Native readiness", {
  skip: process.platform !== "darwin",
}, async () => {
  const token = "adapter-validation-token";
  const protocol = await createProtocolServer(token, { capabilities: "[]" });
  let adapter;
  try {
    adapter = createExternalSocketAdapter({
      socketPath: protocol.socketPath,
      authenticationToken: token,
      connectTimeoutMs: 1_000,
      onError: () => {},
    });
    const capabilities = await adapter.start();
    assert.equal(capabilities.replay, false);
    const window = fakeWindow(302);
    const registration = {
      webContents: window.webContents,
      container: window,
      metadata: {},
    };
    adapter.registerWebContents(registration);
    assert.throws(() => adapter.sendBrowserEvent(registration, logEvent()), /does not expose Browser Log/);
    assert.throws(() => adapter.sendBrowserEvent(registration, replayEvent()), /not enabled by the Native host/);
    adapter.unregisterWebContents(registration);
  } finally {
    await adapter?.stop();
    await protocol.close();
  }
});

test("macOS Mixed Mode rejects an invalid authentication token", {
  skip: process.platform !== "darwin",
}, async () => {
  const protocol = await createProtocolServer("expected-token");
  try {
    const adapter = createExternalSocketAdapter({
      socketPath: protocol.socketPath,
      authenticationToken: "wrong-token",
      connectTimeoutMs: 1_000,
    });
    await assert.rejects(adapter.start(), /closed before authentication completed/);
    await adapter.stop();
  } finally {
    await protocol.close();
  }
});

test("macOS Mixed Mode times out when the Native host never becomes ready", {
  skip: process.platform !== "darwin",
}, async () => {
  const protocol = await createProtocolServer("timeout-token", {}, { sendReady: false });
  try {
    const adapter = createExternalSocketAdapter({
      socketPath: protocol.socketPath,
      authenticationToken: "timeout-token",
      connectTimeoutMs: 20,
    });
    await assert.rejects(adapter.start(), /Timed out connecting/);
    await adapter.stop();
  } finally {
    await protocol.close();
  }
});
