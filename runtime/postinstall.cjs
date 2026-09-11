"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { TARGETS, targetFor } = require("./config.cjs");

async function postinstall({ packageRoot = path.resolve(__dirname, ".."), environment = process.env,
  platform = process.platform, arch = process.arch, install, log = console.log } = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.private || /^(1|true)$/i.test(environment.GUANCE_NATIVE_SKIP_DOWNLOAD || "")) {
    log("Native runtime installation explicitly skipped (or private source checkout).");
    return { skipped: true };
  }
  const target = environment.GUANCE_NATIVE_RUNTIME_TARGET || targetFor(platform, arch);
  if (!target) { log("Native runtime is unavailable on this host; external mode requires an application-owned SDK."); return { skipped: true }; }
  if (!TARGETS.includes(target)) throw new Error("Unsupported runtime target: " + target);
  const defaults = metadata.nativeRuntime?.targets?.[target] || {};
  const sdkVersion = environment.GUANCE_NATIVE_SDK_VERSION || defaults.sdkVersion;
  if (!sdkVersion) throw new Error("No default SDK version configured for " + target + ". Set GUANCE_NATIVE_SDK_VERSION, or GUANCE_NATIVE_SKIP_DOWNLOAD=1 for npm pipeline-only validation.");
  const local = environment.GUANCE_NATIVE_RUNTIME_ARCHIVE;
  const options = { target, sdkVersion,
    assetName: environment.GUANCE_NATIVE_RUNTIME_ASSET_NAME || defaults.assetName,
    runtimeArchive: local ? path.resolve(environment.INIT_CWD || packageRoot, local) : undefined,
    downloadBaseURL: environment.GUANCE_NATIVE_RUNTIME_DOWNLOAD_BASE_URL };
  const installer = install || (await import(pathToFileURL(path.join(packageRoot, "native/darwin/scripts/lib/install-runtime.mjs")).href)).installManagedRuntime;
  const output = await installer({ applicationRoot: packageRoot, options });
  log("Installed Native SDK runtime in " + output);
  return { output, target };
}
if (require.main === module) postinstall().catch((error) => {
  console.error("Native runtime installation failed: " + error.message + "\nFor offline installation set GUANCE_NATIVE_RUNTIME_ARCHIVE to the SDK archive with its .sha256 sidecar. To skip explicitly, set GUANCE_NATIVE_SKIP_DOWNLOAD=1.");
  process.exitCode = 1;
});
module.exports = { postinstall };
