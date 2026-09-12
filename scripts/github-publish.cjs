"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { packRelease } = require("./pack-release.cjs");
const { publishRelease } = require("./publish-release.cjs");
const { execFileSync } = require("node:child_process");

function releaseOptions(env) {
  const match = /^refs\/tags\/agent_((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(?:0|[1-9][0-9]*))?)$/.exec(env.GITHUB_REF || "");
  if (!match) throw new Error("Select an agent_<version> tag; branch publication is forbidden.");
  const flag = env.ELECTRON_PIPELINE_ONLY || "false";
  if (!["true", "false"].includes(flag)) throw new Error("ELECTRON_PIPELINE_ONLY must be true or false.");
  const pipelineOnly = flag === "true";
  if (pipelineOnly && match[2] !== "alpha") throw new Error("Pipeline-only publication is restricted to alpha tags.");
  return { version: match[1], tag: match[2] || "latest", pipelineOnly,
    macosSdkVersion: env.MACOS_SDK_TAG || undefined,
    windowsSdkVersion: env.WINDOWS_SDK_TAG || undefined,
    windowsAssetName: env.WINDOWS_ASSET_NAME || undefined };
}

async function main(stage, env = process.env) {
  const options = releaseOptions(env);
  const root = path.resolve(__dirname, "..");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const sha = git("rev-parse", "HEAD");
  if (sha !== env.GITHUB_SHA || git("rev-parse", env.GITHUB_REF + "^{commit}") !== sha) {
    throw new Error("Workflow SHA, release tag and checkout must match.");
  }
  const directory = path.join(root, "artifacts", "release");
  if (stage === "prepare") {
    await packRelease({ ...options, root, output: directory });
    execFileSync(process.execPath, [path.join(__dirname, "verify-release.cjs"), "--directory", directory, "--skip-runtime"], { cwd: root, stdio: "inherit" });
    await publishRelease({ directory, registry: "https://registry.npmjs.org/", tag: options.tag, access: "public" });
    fs.writeFileSync(path.join(directory, "github-release-context.json"), JSON.stringify({ sha, version: options.version, tag: options.tag }) + "\n");
  } else if (stage === "publish") {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "github-release-context.json"), "utf8"));
    if (saved.sha !== sha || saved.version !== options.version || saved.tag !== options.tag) throw new Error("Prepared artifact context does not match this release.");
    await publishRelease({ directory, registry: "https://registry.npmjs.org/", tag: options.tag, access: "public", execute: true });
  } else {
    throw new Error("Use prepare or publish.");
  }
}

if (require.main === module) main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { releaseOptions };
