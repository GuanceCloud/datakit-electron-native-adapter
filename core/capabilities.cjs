"use strict";

const { PROTOCOL_VERSION } = require("./channels.cjs");

const REPLAY_PRIVACY_LEVELS = new Set(["allow", "mask-user-input", "mask"]);

function normalizeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native Adapter capabilities must be an object.");
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Native Adapter does not support protocol ${PROTOCOL_VERSION}.`);
  }
  const normalized = { protocolVersion: PROTOCOL_VERSION };
  for (const name of ["rum", "log", "replay", "trace"]) {
    if (typeof value[name] !== "boolean") {
      throw new Error(`Native Adapter capability ${name} must be a boolean.`);
    }
    normalized[name] = value[name];
  }
  if (!normalized.rum) {
    throw new Error("Native Adapter must enable the RUM capability.");
  }
  if (!REPLAY_PRIVACY_LEVELS.has(value.replayPrivacy)) {
    throw new Error("Native Adapter Replay privacy capability is invalid.");
  }
  normalized.replayPrivacy = normalized.replay ? value.replayPrivacy : "mask";
  if (typeof value.traceSampleRate !== "number" ||
      !Number.isFinite(value.traceSampleRate) ||
      value.traceSampleRate < 0 || value.traceSampleRate > 100) {
    throw new Error("Native Adapter traceSampleRate must be from 0 through 100.");
  }
  normalized.traceSampleRate = value.traceSampleRate;
  if (typeof value.traceType !== "string" || !value.traceType.trim()) {
    throw new Error("Native Adapter traceType must be a non-empty string.");
  }
  normalized.traceType = value.traceType.trim();
  if (value.allowedWebViewHosts !== undefined && value.allowedWebViewHosts !== null) {
    if (!Array.isArray(value.allowedWebViewHosts) ||
        value.allowedWebViewHosts.some((host) => typeof host !== "string" || !host.trim())) {
      throw new Error("Native Adapter allowedWebViewHosts must be an array of strings.");
    }
    normalized.allowedWebViewHosts = Object.freeze(
      value.allowedWebViewHosts.map((host) => host.trim()),
    );
  }
  return Object.freeze(normalized);
}

function rendererConfiguration(capabilities) {
  const configuration = {
    replayEnabled: capabilities.replay,
    replayPrivacy: capabilities.replay ? capabilities.replayPrivacy : "mask",
  };
  if (capabilities.allowedWebViewHosts) {
    configuration.allowedWebViewHosts = capabilities.allowedWebViewHosts;
  }
  return Object.freeze(configuration);
}

module.exports = {
  normalizeCapabilities,
  rendererConfiguration,
  REPLAY_PRIVACY_LEVELS,
};
