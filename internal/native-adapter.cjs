"use strict";

const REQUIRED_METHODS = [
  "start",
  "registerWebContents",
  "updateWebContents",
  "sendBrowserEvent",
  "unregisterWebContents",
  "onCommand",
  "getState",
  "stop",
];

function assertNativeAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("A Native Adapter object is required.");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`Native Adapter must provide ${method}().`);
    }
  }
  return adapter;
}

function inactiveCommandSubscription(listener) {
  if (typeof listener !== "function") {
    throw new Error("Native Adapter command listener must be a function.");
  }
  return () => {};
}

module.exports = {
  assertNativeAdapter,
  inactiveCommandSubscription,
};
