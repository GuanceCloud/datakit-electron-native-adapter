"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Writable } = require("node:stream");
const test = require("node:test");
const {
  createManagedProcessAdapter,
} = require("../platform/win32/managed-process.cjs");

const HANDSHAKE = [
  "@guance-capabilities",
  "protocol=1",
  "rum=1",
  "log=0",
  "replay=0",
  "replay_privacy=mask",
  "trace=0",
  "trace_sample_rate=0",
  "trace_type=w3c_traceparent",
  "trace_allowed_urls=",
  "debug=0",
].join("\t") + "\n";

function actionEvent(index) {
  return JSON.stringify({
    name: "rum",
    data: {
      measurement: "action",
      time: 1_700_000_000_000 + index,
      tags: { action_name: `burst-${index}` },
      fields: { duration: index },
    },
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.received = "";
  child.stdin = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      child.received += String(chunk);
      setImmediate(callback);
    },
  });
  child.stdin.once("finish", () => {
    child.exitCode = 0;
    setImmediate(() => child.emit("exit", 0, null));
  });
  child.kill = () => {
    child.exitCode = 1;
    child.emit("exit", 1, null);
  };
  setImmediate(() => child.stdout.emit("data", HANDSHAKE));
  return child;
}

test("managed mode queues a bounded Renderer burst until stdin drains", async () => {
  const child = fakeChild();
  const adapter = createManagedProcessAdapter({
    directory: __dirname,
    settings: {
      applicationId: "backpressure-test",
      datakitUrl: "http://127.0.0.1:9",
      service: "electron-adapter-test",
      environment: "test",
      version: "0",
    },
    spawnProcess: () => child,
    fileExists: () => true,
    stopTimeoutMs: 1_000,
  });
  await adapter.start();

  for (let index = 0; index < 100; index += 1) {
    assert.doesNotThrow(() => adapter.sendBrowserEvent(undefined, actionEvent(index)));
  }
  const deadline = Date.now() + 2_000;
  while (adapter.getState().pendingBytes > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(adapter.getState().pendingBytes, 0);
  assert.equal(child.received.split("\n").filter(Boolean).length, 100);
  await adapter.stop();
});
