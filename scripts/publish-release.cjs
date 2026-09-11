"use strict";

const path = require("node:path");
const { npm } = require("./npm-command.cjs");
const { readReleaseArtifact } = require("./github-release-artifact.cjs");
const { argumentsFor } = require("./release-common.cjs");

async function publishRelease({ directory, registry, tag, access, execute = false, localOnly = false },
  { runNpm = npm, log = console.log } = {}) {
  if (!directory || !registry || !/^[a-z][a-z0-9._-]*$/.test(tag || "") || !["public", "restricted"].includes(access)) {
    throw new Error("Specify --directory, --registry, --tag and --access public|restricted; --execute publishes.");
  }
  const url = new URL(registry);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Release registry must use HTTPS without credentials in its URL.");
  const root = path.resolve(directory);
  const { report, tarball } = readReleaseArtifact(root);
  if (report.version.includes("-") && tag === "latest") throw new Error("A prerelease must use an explicit prerelease dist-tag, such as alpha.");
  // SDK releases are independently versioned and installed explicitly by consumers.
  // --local-only remains an accepted compatibility flag; native URLs are never a publish prerequisite.
  log("Native SDK assets are not checked by npm publication; native installation acceptance is separate.");
  if (!execute) { log("Release preflight passed; nothing published."); return { published: false }; }
  const identity = report.package.name + "@" + report.version;
  let existing;
  try { existing = JSON.parse(await runNpm(["view", identity, "dist.integrity", "--json", "--registry", registry], root)); }
  catch (error) { if (!/\bE404\b/.test(error.message)) throw error; }
  if (existing !== undefined) {
    if (existing !== report.package.integrity) throw new Error("An existing npm version has different integrity; do not overwrite it.");
    await runNpm(["dist-tag", "add", identity, tag, "--registry", registry], root);
    log("Existing npm bytes match; restored dist-tag for " + identity);
    return { published: false, existing: true };
  }
  await runNpm(["publish", tarball, "--registry", registry, "--tag", tag, "--access", access, "--ignore-scripts"], root);
  const integrity = JSON.parse(await runNpm(["view", identity, "dist.integrity", "--json", "--registry", registry], root));
  if (integrity !== report.package.integrity) throw new Error("Published npm integrity is not yet verified. Keep these artifacts and rerun preflight before retrying.");
  log("Published and verified " + identity);
  return { published: true };
}

if (require.main === module) {
  try {
    const args = argumentsFor(process.argv.slice(2), ["directory", "registry", "tag", "access"], ["execute", "local-only"]);
    publishRelease({ ...args, localOnly: args["local-only"] }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { publishRelease };
