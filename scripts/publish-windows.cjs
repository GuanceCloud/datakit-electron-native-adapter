"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { npm } = require("./npm-command.cjs");
const { PACKAGE_NAME, validateRuntime } = require("../platform/win32/runtime.cjs");

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const directory = value("--directory");
  const registry = value("--registry");
  const tag = value("--tag");
  const access = value("--access");
  if (!directory || !registry || !tag || !["public", "restricted"].includes(access)) {
    throw new Error("Specify --directory, --registry, --tag and --access public|restricted. Default operation is validation only; --execute publishes.");
  }
  if (new URL(registry).protocol !== "https:") throw new Error("Release registry must use HTTPS.");
  const root = path.resolve(directory);
  const report = JSON.parse(fs.readFileSync(path.join(root, "pack-report.json"), "utf8"));
  const manifest = validateRuntime(path.join(root, "win32-x64/runtime"), { version: report.version });
  if (manifest.source.dirty || report.nativeSource.dirty) throw new Error("Dirty native artifacts cannot be published by this release helper.");
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "main/package.json"), "utf8"));
  if (metadata.private || metadata.version !== report.version || metadata.optionalDependencies[PACKAGE_NAME] !== report.version) {
    throw new Error("Invalid main release manifest or platform version.");
  }
  for (const record of [report.platform, report.main]) {
    if (path.basename(record.filename) !== record.filename) throw new Error("Invalid tarball filename.");
    const actual = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(path.join(root, record.filename))).digest("base64");
    if (actual !== record.integrity) throw new Error(`Tarball integrity mismatch: ${record.filename}`);
  }
  if (!args.includes("--execute")) { console.log("Release artifacts validated; nothing published. Review signing policy and target OS acceptance before --execute."); return; }
  const options = ["--registry", registry, "--tag", tag, "--access", access, "--ignore-scripts"];
  if (!args.includes("--platform-already-published")) {
    await npm(["publish", path.join(root, report.platform.filename), ...options], root);
  }
  const published = JSON.parse(await npm(["view", `${PACKAGE_NAME}@${report.version}`, "dist.integrity", "--json", "--registry", registry], root));
  if (published !== report.platform.integrity) throw new Error("Platform publication is not yet available with expected integrity. Main package was not published.");
  await npm(["publish", path.join(root, report.main.filename), ...options], root);
  console.log(`Published platform then main at ${report.version}.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
