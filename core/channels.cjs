"use strict";

const PROTOCOL_VERSION = 1;

module.exports = Object.freeze({
  PROTOCOL_VERSION,
  BRIDGE_CHANNEL: `guance:electron-rum:browser-event:v${PROTOCOL_VERSION}`,
  BRIDGE_CONFIGURATION_CHANNEL: `guance:electron-rum:configuration:v${PROTOCOL_VERSION}`,
  DEFAULT_PIPE_NAME: "guance-rum-electron-native-owned",
  MAX_BRIDGE_PAYLOAD_BYTES: 1024 * 1024,
  MAX_CAPABILITIES_BYTES: 16 * 1024,
});
