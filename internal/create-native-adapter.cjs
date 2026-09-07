"use strict";

const { createDarwinEmbeddedAdapter } = require("../platform/darwin/embedded.cjs");
const { createWindowsAdapter } = require("../platform/win32/index.cjs");

function createNativeAdapter(native, onError, platform = process.platform) {
  if (platform === "win32") return createWindowsAdapter(native, onError);
  if (platform === "darwin") {
    if (native.mode !== "embedded") {
      throw new Error('native.mode must be "embedded" on macOS.');
    }
    return createDarwinEmbeddedAdapter({ ...native, onError });
  }
  throw new Error(`Electron Native Adapter does not support ${platform}.`);
}

module.exports = { createNativeAdapter };
