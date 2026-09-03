"use strict";

const { createManagedProcessAdapter } = require("./managed-process.cjs");
const { createNamedPipeAdapter } = require("./named-pipe.cjs");

function createWindowsAdapter(native, onError) {
  if (native.mode === "managed") return createManagedProcessAdapter({ ...native, onError });
  if (native.mode === "external") return createNamedPipeAdapter({ ...native, onError });
  throw new Error('native.mode must be "managed" or "external" on Windows.');
}

module.exports = { createWindowsAdapter };
