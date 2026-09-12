"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { packWindows } = require("../scripts/pack-windows.cjs");
const { publishWindows } = require("../scripts/publish-windows.cjs");
const { verify } = require("../scripts/verify-windows-tarballs.cjs");

test("retired bundled-runtime workflows fail with the replacement commands", async () => {
  assert.throws(() => packWindows({}), /pack:release/);
  await assert.rejects(publishWindows({ execute: true }), /publish:release/);
  await assert.rejects(verify("."), /verify:release/);
});
