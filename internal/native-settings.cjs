"use strict";

const {
  integer,
  optionalString,
  rate,
  requireObject,
  requiredString,
} = require("./options.cjs");

function normalizeNativeSettings(settings) {
  requireObject(settings, "native.settings");
  const applicationId = requiredString(settings.applicationId, "native.settings.applicationId");
  const datakitUrl = optionalString(settings.datakitUrl, "native.settings.datakitUrl").trim();
  const datawayUrl = optionalString(settings.datawayUrl, "native.settings.datawayUrl").trim();
  if (!datakitUrl && !datawayUrl) {
    throw new Error("native.settings.datakitUrl or native.settings.datawayUrl is required.");
  }
  const replayPrivacy = optionalString(settings.replayPrivacy, "native.settings.replayPrivacy") || "mask";
  if (!["allow", "mask-user-input", "mask"].includes(replayPrivacy)) {
    throw new Error("native.settings.replayPrivacy is invalid.");
  }
  return Object.freeze({
    applicationId,
    datakitUrl,
    datawayUrl,
    clientToken: optionalString(settings.clientToken, "native.settings.clientToken"),
    service: requiredString(settings.service, "native.settings.service"),
    environment: requiredString(settings.environment, "native.settings.environment"),
    version: requiredString(settings.version, "native.settings.version"),
    cachePath: optionalString(settings.cachePath, "native.settings.cachePath"),
    sampleRate: rate(settings.sampleRate, 1, "native.settings.sampleRate"),
    loggingEnabled: Boolean(settings.loggingEnabled),
    loggingSampleRate: rate(settings.loggingSampleRate, 1, "native.settings.loggingSampleRate"),
    replayEnabled: Boolean(settings.replayEnabled),
    replaySampleRate: rate(settings.replaySampleRate, 1, "native.settings.replaySampleRate"),
    replayPrivacy,
    traceEnabled: Boolean(settings.traceEnabled),
    traceSampleRate: rate(settings.traceSampleRate, 1, "native.settings.traceSampleRate"),
    traceType: optionalString(settings.traceType, "native.settings.traceType") || "w3c_traceparent",
    traceAllowedUrls: optionalString(settings.traceAllowedUrls, "native.settings.traceAllowedUrls"),
    debug: Boolean(settings.debug),
    httpTimeoutMs: integer(settings.httpTimeoutMs, 10_000, 1, 300_000, "native.settings.httpTimeoutMs"),
  });
}

module.exports = { normalizeNativeSettings };
