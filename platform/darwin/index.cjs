"use strict";

const { createManagedAdapter } = require("./managed.cjs");
const { createExternalSocketAdapter } = require("./external-socket.cjs");

function createDarwinAdapter(native, electron, onError) {
  if (native.mode === "managed") {
    return createManagedAdapter({ ...native, electron, onError });
  }
  if (native.mode === "external") {
    return createExternalSocketAdapter({ ...native, onError });
  }
  throw new Error('native.mode must be "managed" or "external" on macOS.');
}

module.exports = { createDarwinAdapter };
