"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const buildModulePath = path.join(
  root,
  "native/darwin/scripts/lib/build-runtime.mjs",
);

async function buildModule() {
  return import(pathToFileURL(buildModulePath).href);
}

function createNativeSDKFixture() {
  const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "guance-native-sdk-"));
  const header = path.join(
    sdkRoot,
    "Sources/ElectronNative/Bridge/Public/GuanceElectronBridge.h",
  );
  const addon = path.join(
    sdkRoot,
    "Sources/ElectronNative/NodeAddon/guance_electron.mm",
  );
  fs.mkdirSync(path.dirname(header), { recursive: true });
  fs.mkdirSync(path.dirname(addon), { recursive: true });
  fs.writeFileSync(
    path.join(sdkRoot, "Package.swift"),
    '.library(name: "GuanceElectronNative", type: .static, targets: [])\n',
  );
  fs.writeFileSync(header, "#pragma once\n");
  fs.writeFileSync(
    path.join(sdkRoot, "Sources/ElectronNative/Bridge/GuanceElectronBridge.m"),
    "// fixture\n",
  );
  fs.writeFileSync(addon, "// fixture\n");
  return sdkRoot;
}

test("Darwin build arguments default to release and the fixed Native SDK tag", async () => {
  const {
    DEFAULT_NATIVE_SDK_REF,
    DEFAULT_NATIVE_SDK_REPOSITORY,
    parseBuildArguments,
  } = await buildModule();
  const options = parseBuildArguments([], {});

  assert.equal(options.configuration, "release");
  assert.equal(options.sdkRef, "1.6.8-alpha.3");
  assert.equal(options.sdkRef, DEFAULT_NATIVE_SDK_REF);
  assert.equal(options.sdkRepository, DEFAULT_NATIVE_SDK_REPOSITORY);
});

test("Darwin build arguments allow local SDK development overrides", async () => {
  const { darwinArchitecture, parseBuildArguments } = await buildModule();
  const options = parseBuildArguments(
    ["--debug", "--sdk-root", "/tmp/native-sdk"],
    {},
  );

  assert.equal(options.configuration, "debug");
  assert.equal(options.sdkRoot, "/tmp/native-sdk");
  assert.equal(darwinArchitecture("arm64"), "arm64");
  assert.equal(darwinArchitecture("x64"), "x86_64");
  assert.throws(() => darwinArchitecture("ia32"), /Unsupported Node architecture/u);
  assert.throws(
    () => parseBuildArguments(["--mode", "external"], {}),
    /Unknown argument/u,
  );
  assert.throws(
    () => parseBuildArguments(["--unknown"], {}),
    /Unknown argument/u,
  );
});

test("Darwin source validation requires the Native SDK product, bridge header, and addon source", async (t) => {
  const { validateNativeSDKSource } = await buildModule();
  const sdkRoot = createNativeSDKFixture();
  t.after(() => fs.rmSync(sdkRoot, { recursive: true, force: true }));

  assert.equal(validateNativeSDKSource(sdkRoot), sdkRoot);
  fs.rmSync(path.join(
    sdkRoot,
    "Sources/ElectronNative/NodeAddon/guance_electron.mm",
  ));
  assert.throws(
    () => validateNativeSDKSource(sdkRoot),
    /missing Sources\/ElectronNative\/NodeAddon\/guance_electron\.mm/u,
  );
});

test("Darwin source validation rejects a dynamic GuanceElectronNative product", async (t) => {
  const { validateNativeSDKSource } = await buildModule();
  const sdkRoot = createNativeSDKFixture();
  t.after(() => fs.rmSync(sdkRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(sdkRoot, "Package.swift"),
    '.library(name: "GuanceElectronNative", type: .dynamic, targets: [])\n',
  );

  assert.throws(
    () => validateNativeSDKSource(sdkRoot),
    /does not declare the static GuanceElectronNative product/u,
  );
});

test("Darwin addon statically links the Native SDK and preserves Objective-C Categories", async () => {
  const { nativeAddonLinkArguments } = await buildModule();
  const args = nativeAddonLinkArguments({
    architecture: "arm64",
    nodeHeadersPath: "/node/include",
    outputPath: "/runtime/guance_electron.node",
    sdkRoot: "/native-sdk",
    staticLibraryPath: "/build/libGuanceElectronNative.a",
  });

  assert.ok(args.includes("-Wl,-ObjC"));
  assert.ok(args.includes("-Wl,-dead_strip"));
  assert.ok(args.includes("/build/libGuanceElectronNative.a"));
  assert.equal(args.some((argument) => argument.includes("GuanceElectronNative.dylib")), false);
  assert.equal(args.some((argument) => argument.includes("@loader_path")), false);
});
