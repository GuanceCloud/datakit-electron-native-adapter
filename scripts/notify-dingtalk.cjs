"use strict";

const fs = require("node:fs");
const path = require("node:path");
const REPOSITORY = "GuanceCloud/datakit-electron-native-adapter";
const PACKAGE = "@cloudcare/electron-native-adapter";

function notificationPayload(env, receipt, report) {
  const ref = env.GITHUB_REF || "";
  const match = /^refs\/tags\/agent_((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(?:0|[1-9][0-9]*))?)$/.exec(ref);
  if (!match || env.GITHUB_REPOSITORY !== REPOSITORY || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || "") ||
      receipt.schemaVersion !== 1 || receipt.npm !== "verified" || receipt.repository !== REPOSITORY ||
      receipt.sha !== env.GITHUB_SHA || receipt.runId !== env.GITHUB_RUN_ID || receipt.runAttempt !== env.GITHUB_RUN_ATTEMPT ||
      receipt.version !== match[1] || receipt.tag !== (match[2] || "latest") || receipt.name !== PACKAGE ||
      report.schemaVersion !== 5 || report.adapterSource?.dirty !== false || report.adapterSource?.commit !== env.GITHUB_SHA ||
      report.version !== receipt.version || report.package?.name !== PACKAGE || report.package?.version !== receipt.version ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(receipt.integrity || "") || report.package?.integrity !== receipt.integrity) {
    throw new Error("Notification requires verified npm publication evidence for this run, tag and commit.");
  }
  const publisher = env.GITHUB_ACTOR || "GitHub Actions";
  if (!/^[A-Za-z0-9 _\[\]-]+$/.test(publisher)) throw new Error("Invalid publisher identity.");
  const title = "Electron FT " + ref.slice("refs/tags/".length) + " published";
  const run = "https://github.com/" + REPOSITORY + "/actions/runs/" + env.GITHUB_RUN_ID;
  const text = "### " + title + "\n\n**Publisher**: " + publisher + "\n\n" +
    "**npm**: " + PACKAGE + "@" + receipt.version + " (" + receipt.tag + ")\n\n" +
    "**Integrity**: verified\n\n[npm package](https://www.npmjs.com/package/" + PACKAGE + "/v/" + receipt.version + ")\n\n" +
    "[GitHub Actions](" + run + ")\n\n";
  return { msgtype: "actionCard", actionCard: { title, text, hideAvatar: "0" } };
}

async function sendNotification(payload, token, request = fetch) {
  if (!/^[A-Za-z0-9_-]+$/.test(token || "")) throw new Error("DingTalk webhook credential is missing or invalid.");
  try {
    const response = await request("https://oapi.dingtalk.com/robot/send?access_token=" + encodeURIComponent(token), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30000), redirect: "error",
    });
    if (!response.ok || (await response.json()).errcode !== 0) throw new Error("Rejected");
  } catch {
    // HTTP errors can contain the credential-bearing URL; never echo them.
    throw new Error("DingTalk notification failed; npm publication remains verified. Check the robot configuration.");
  }
}

async function main() {
  const directory = path.resolve(__dirname, "../artifacts/release");
  const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  const payload = notificationPayload(process.env, read("npm-publication.json"), read("pack-report.json"));
  await sendNotification(payload, process.env.FT_SDK_DINGTALK_WEBHOOK_TOKEN);
  console.log("DingTalk accepted the verified Electron npm release notification.");
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { notificationPayload, sendNotification };
