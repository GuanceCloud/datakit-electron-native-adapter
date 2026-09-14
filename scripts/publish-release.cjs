"use strict";

const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { npm } = require("./npm-command.cjs");
const { readReleaseArtifact } = require("./github-release-artifact.cjs");
const { argumentsFor } = require("./release-common.cjs");

async function publishRelease({ directory, registry, tag, access, execute = false, localOnly = false, verifyOnly = false },
  { runNpm = npm, log = console.log, wait = delay } = {}) {
  if (!directory || !registry || !/^[a-z][a-z0-9._-]*$/.test(tag || "") || !["public", "restricted"].includes(access)) {
    throw new Error("Specify --directory, --registry, --tag and --access public|restricted; --execute publishes.");
  }
  if (execute && verifyOnly) throw new Error("--execute and --verify-only cannot be combined.");
  const url = new URL(registry);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Release registry must use HTTPS without credentials in its URL.");
  const root = path.resolve(directory);
  const { report, tarball } = readReleaseArtifact(root);
  if (report.version.includes("-") && tag === "latest") throw new Error("A prerelease must use an explicit prerelease dist-tag, such as alpha.");
  // SDK releases are independently versioned and installed explicitly by consumers.
  // --local-only remains an accepted compatibility flag; native URLs are never a publish prerequisite.
  log("Native SDK assets are not checked by npm publication; native installation acceptance is separate.");
  const identity = report.package.name + "@" + report.version;
  const viewIntegrity = async () => JSON.parse(await runNpm(["view", identity, "dist.integrity", "--json", "--registry", registry,
    "--prefer-online", "--fetch-retries=0", "--fetch-timeout=15000"], root));
  const verifyIntegrity = async () => {
    const retryDelays = [1000, 2000, 4000, 8000, 15000];
    for (let attempt = 0; ; attempt++) {
      let integrity;
      try { integrity = await viewIntegrity(); }
      catch (error) {
        if (!/\bE404\b/.test(error.message) || attempt === retryDelays.length) {
          throw new Error("Registry verification failed for " + identity + ". Keep the existing artifacts and use --verify-only to check again without uploading.\n" + error.message);
        }
        log("Registry still returns E404 for " + identity + "; retrying verification in " + retryDelays[attempt] / 1000 + "s (no upload).");
        await wait(retryDelays[attempt]);
        continue;
      }
      if (integrity !== report.package.integrity) throw new Error("Published npm integrity differs from the local tarball. Do not republish; retain these artifacts for investigation.");
      return;
    }
  };
  if (verifyOnly) {
    await verifyIntegrity();
    log("Verified existing npm integrity for " + identity + "; nothing uploaded or changed.");
    return { published: false, verified: true };
  }
  if (!execute) { log("Release preflight passed; nothing published."); return { published: false }; }
  let existing;
  try { existing = await viewIntegrity(); }
  catch (error) { if (!/\bE404\b/.test(error.message)) throw error; }
  if (existing !== undefined) {
    if (existing !== report.package.integrity) throw new Error("An existing npm version has different integrity; do not overwrite it.");
    await runNpm(["dist-tag", "add", identity, tag, "--registry", registry], root);
    log("Existing npm bytes match; restored dist-tag for " + identity);
    return { published: false, existing: true };
  }
  await runNpm(["publish", tarball, "--registry", registry, "--tag", tag, "--access", access, "--ignore-scripts"], root);
  log("npm publish completed for " + identity + "; verifying registry integrity.");
  await verifyIntegrity();
  log("Published and verified " + identity);
  return { published: true };
}

if (require.main === module) {
  try {
    const args = argumentsFor(process.argv.slice(2), ["directory", "registry", "tag", "access"], ["execute", "local-only", "verify-only"]);
    publishRelease({ ...args, localOnly: args["local-only"], verifyOnly: args["verify-only"] }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { publishRelease };
