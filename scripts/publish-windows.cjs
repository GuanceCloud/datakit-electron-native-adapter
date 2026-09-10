"use strict";

const path = require("node:path");
const { npm } = require("./npm-command.cjs");
const { readReleaseArtifact } = require("./release-artifact.cjs");

async function publishWindows({ directory, registry, tag, access, execute = false }, runNpm = npm) {
  if (!directory || !registry || !tag || !["public", "restricted"].includes(access)) {
    throw new Error("Specify --directory, --registry, --tag and --access public|restricted. Default operation is validation only; --execute publishes.");
  }
  const url = new URL(registry);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Release registry must use HTTPS without credentials in its URL.");
  const root = path.resolve(directory);
  const { report, tarball } = readReleaseArtifact(root);
  if (!execute) {
    console.log("Single-package release artifacts validated; nothing published.");
    return;
  }
  await runNpm(["publish", tarball, "--registry", registry, "--tag", tag, "--access", access, "--ignore-scripts"], root);
  console.log("Published " + report.package.name + "@" + report.version);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (args.includes("--platform-already-published")) {
    console.error("--platform-already-published is obsolete: this release contains one npm package.");
    process.exitCode = 1;
  } else {
    publishWindows({ directory: value("--directory"), registry: value("--registry"), tag: value("--tag"), access: value("--access"), execute: args.includes("--execute") })
      .catch((error) => { console.error(error); process.exitCode = 1; });
  }
}
module.exports = { publishWindows };
