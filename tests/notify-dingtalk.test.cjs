"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { notificationPayload, sendNotification } = require("../scripts/notify-dingtalk.cjs");
const { publishCandidate } = require("../scripts/github-publish.cjs");

function fixture() {
  const env = { GITHUB_REPOSITORY: "GuanceCloud/datakit-electron-native-adapter", GITHUB_REF: "refs/tags/agent_1.2.3-alpha.1",
    GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTOR: "release-user" };
  const receipt = { schemaVersion: 1, npm: "verified", repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA,
    runId: "123", runAttempt: "1", version: "1.2.3-alpha.1", tag: "alpha", name: "@cloudcare/electron-native-adapter", integrity: "sha512-YWJj" };
  const report = { schemaVersion: 5, adapterSource: { dirty: false, commit: env.GITHUB_SHA }, version: receipt.version,
    package: { name: receipt.name, version: receipt.version, integrity: receipt.integrity } };
  return { env, receipt, report };
}

test("verified release uses Android actionCard format and FT keyword", () => {
  const { env, receipt, report } = fixture();
  const payload = notificationPayload(env, receipt, report);
  assert.equal(payload.msgtype, "actionCard");
  assert.equal(payload.actionCard.title, "Electron FT agent_1.2.3-alpha.1 published");
  assert.match(payload.actionCard.text, /Publisher\*\*: release-user/);
  assert.match(payload.actionCard.text, /Integrity\*\*: verified/);
  assert.match(payload.actionCard.text, /actions\/runs\/123/);
  assert.match(JSON.stringify(payload), /^[\x00-\x7f]*$/);
});

test("unverified, stale or mismatched publication evidence cannot notify", () => {
  for (const changes of [{ npm: "pending" }, { sha: "b".repeat(40) }, { runAttempt: "2" }, { runId: "999" },
    { version: "1.2.4" }, { tag: "latest" }, { name: "other" }, { integrity: "sha512-different" }]) {
    const { env, receipt, report } = fixture();
    assert.throws(() => notificationPayload(env, { ...receipt, ...changes }, report), /evidence/);
  }
  const { env, receipt, report } = fixture();
  assert.throws(() => notificationPayload({ ...env, GITHUB_REF: "refs/heads/dev" }, receipt, report));
  assert.throws(() => notificationPayload(env, receipt, { ...report, adapterSource: { dirty: true, commit: env.GITHUB_SHA } }));
});

test("HTTP and DingTalk business errors fail without exposing the webhook secret", async () => {
  const token = "fake-test-only-token";
  let called = false;
  await sendNotification({ msgtype: "actionCard" }, token, async (url, options) => {
    called = true;
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(options.body).msgtype, "actionCard");
    return { ok: true, json: async () => ({ errcode: 0 }) };
  });
  assert.equal(called, true);
  for (const request of [async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ errcode: 310000 }) }),
    async () => { throw new Error("secret URL access_token=" + token); }]) {
    await assert.rejects(sendNotification({}, token, request), (error) => !error.message.includes(token) && /npm publication remains verified/.test(error.message));
  }
  await assert.rejects(sendNotification({}, "", async () => { assert.fail("No HTTP request without a credential"); }));
});

test("publication receipt is written only after verified publishing and cleared on failure", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "electron-notification-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { env, receipt, report } = fixture();
  const options = { version: receipt.version, tag: receipt.tag };
  fs.writeFileSync(path.join(directory, "pack-report.json"), JSON.stringify(report));
  const target = path.join(directory, "npm-publication.json");
  await publishCandidate(directory, options, env.GITHUB_SHA, env, async () => ({ published: true }));
  assert.equal(JSON.parse(fs.readFileSync(target)).npm, "verified");
  await assert.rejects(publishCandidate(directory, options, env.GITHUB_SHA, env, async () => { throw new Error("npm integrity mismatch"); }));
  assert.equal(fs.existsSync(target), false);
  await assert.rejects(publishCandidate(directory, options, env.GITHUB_SHA, env, async () => ({ published: false })));
  assert.equal(fs.existsSync(target), false);
  await publishCandidate(directory, options, env.GITHUB_SHA, env, async () => ({ existing: true }));
  notificationPayload(env, JSON.parse(fs.readFileSync(target)), report);
});
