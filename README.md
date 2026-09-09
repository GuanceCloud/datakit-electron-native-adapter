# `@cloudcare/electron-native-adapter`

CloudCare's Electron Native Adapter connects the Browser RUM SDK running in an Electron Renderer to a CloudCare Native SDK on macOS and Windows.

This package is a CommonJS JavaScript adapter. Windows x64 binaries ship in its exact-version optional dependency `@cloudcare/electron-native-adapter-win32-x64`. In full mode, Electron owns the platform Native SDK through `managed` mode. In mixed mode, the Native host owns the SDK and Electron connects through `external` mode.

## Support status

- Windows managed mode: supported. The Adapter owns the Windows Native Bridge process.
- macOS managed mode: supported. The Adapter owns the macOS Native SDK through its Node-API addon.
- Windows external mode: supported. The application owns the Windows Native SDK and exposes its named-pipe bridge.
- macOS external mode: supported. The Native host owns the macOS Native SDK and its Electron bridge.
- Linux: not supported.

Windows compatibility baselines are Electron `22.3.27` (Windows 7 SP1 through Windows 11) and `43.x` (Windows 10+). The npm peer range is `^22.3.27 || 43.x`; intermediate Electron majors are not yet validated. Electron 22 is the legacy compatibility baseline and is end-of-life; see the [upstream support notice](https://www.electronjs.org/blog/electron-22-0). Native runtime compatibility must also be validated on each target OS. The macOS embedded backend retains its Electron 43.x baseline and requires the matching SDK-distributed native module.

The JavaScript runtime baseline is Node.js `16.17.1`, as embedded in Electron 22. Development and `npm run check` require Node.js `22.12` or newer; users of a packaged application do not need a separate Node.js installation.

## Preferred API

Full mode uses the same `managed` API and `native.settings` object on macOS and Windows.

```js
const { bootstrap } = require("@cloudcare/electron-native-adapter");

const client = await bootstrap({
  electron: require("electron"),
  native: {
    mode: "managed",
    // Windows x64 resolves its npm runtime automatically.
    // On macOS, set directory to your built nativeRuntimeDirectory.
    settings: {
      applicationId: "your-rum-app-id",
      datakitUrl: "http://127.0.0.1:9529",
      service: "desktop-app",
      environment: "production",
      version: "1.0.0",
    },
  },
  autoAttach: true,
});

client.attachWindow(window);
await client.stop();
```

Use `datawayUrl` with `clientToken` instead of `datakitUrl` when reporting through DataWay. Sampling settings use the cross-platform `0..1` range.

`bootstrap()` returns one client with normalized `capabilities`, `attachWindow()`, `detachWindow()`, `updateWindow()`, `transportState`, and idempotent `stop()` methods.

## Native runtime

Windows x64 Full Mode uses npm for the Bridge EXE and Native DLL. It needs no vcpkg, Visual Studio, CMake, or postinstall download. The machine running the application needs the Microsoft Visual C++ v14 x64 Redistributable and Windows Universal CRT; the package does not redistribute CRT DLLs. See the runtime manifest for exact imports and native source revision. The existing platform baselines still require target OS validation.

Managed runtime selection is: explicit `native.directory` (or `startFullMode({ nativeDirectory })`), then `process.resourcesPath/native` if present, then the installed Windows platform package's `runtime` directory. Invalid explicit or staged paths fail without fallback. An explicit legacy build directory may omit the npm manifest; the existing protocol/capabilities handshake is always validated. Default npm runtimes also validate version, architecture, protocol and SHA-256 before starting.

If optional dependencies were omitted, reinstall with `npm install --include=optional`. Only Windows managed mode resolves this dependency. Mixed Mode and macOS do not need it. The npm runtime currently covers x64 only; other architectures require an explicit compatible build.

`spawn()` needs real files outside ASAR. After packaging, stage the complete runtime into the application's resources directory:

```js
const { stageWindowsRuntime } = require("@cloudcare/electron-native-adapter/packaging/windows");
stageWindowsRuntime({ resourcesDirectory: "release/MyApp-win32-x64/resources", arch: "x64" });
```

The destination `resources/native` must be empty. This helper copies bytes without changing signatures and validates the manifest. It also accepts `nativeDirectory` for local native development. For an older manifest-less override, continue passing the explicit directory at application startup. See [npm optional dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#optionaldependencies) and [Electron ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

### Preparing local Windows packages

The source templates remain `private: true` and `0.0.0-local`. The pack script prepares separate publishable manifests with the explicit npm version and an exact optional dependency; it never changes the source version, runs install scripts, or publishes. C++ sources stay in the Windows SDK repository.

```powershell
# Run the Windows SDK's build/export-electron-runtime.ps1 first; output must be empty.
npm run pack:windows -- --runtime ../runtime-export --version 0.0.0-local.1 --output artifacts/local --allow-dirty
npm run verify:windows:tarballs -- artifacts/local
```

`--allow-dirty` is only for local validation. Release export/pack reject dirty source by default. The platform tarball contains exactly EXE, DLL, runtime manifest, README, LICENSE and package.json. The manifest records the independent native SDK version, source commit/dirty status, Release/x64, protocol 1, CRT imports, signatures, and hashes calculated after optional signing. `pack-report.json` records actual npm tarball contents and integrity. The verifier installs only the main tarball in a fresh directory and resolves its optional dependency through a read-only loopback registry, then exercises both public managed APIs and omission errors.

Before a real release, choose the npm version/registry/access/tag, review source and licenses, verify on target Windows systems, and configure signing if required by release policy. Windows export accepts `-SignFile` and `-RequireSignature`; local unsigned builds are supported. Platform and main npm versions stay synchronized; native SDK, NuGet and vcpkg versions are independent. Publish the platform tarball first, confirm it is downloadable, then publish the main tarball. No CI remote, account or credentials are assumed, and no publish runs as part of install/build/check/pack.

The explicit release helper is `npm run publish:windows -- --directory <pack-output> --registry <https-registry> --tag <dist-tag> --access <public-or-restricted>`. Without `--execute` it only validates clean provenance, versions and tarball integrity. With separately authorized `--execute`, it publishes the platform first and checks its registry integrity before publishing main. If platform publication already succeeded, pass `--platform-already-published` to resume after the same integrity check. This helper does not select credentials or signing identity.

On macOS, run the following command from the Electron application root:

```sh
npx ft-electron-native managed
```

The command builds a Universal runtime for Apple Silicon and Intel Macs in `.cloudcare/native/darwin/runtime`. Pass this directory as `native.directory` during development. When packaging the application, copy the complete directory outside ASAR and sign its Native binary with the application.

## Mixed mode

Use `native.mode: "external"` when a Native host owns the platform Native SDK. Do not pass `native.settings`, because SDK configuration belongs to the Native host.

On Windows, the host exposes a named-pipe bridge; `pipeName`, `timeoutMs`, and `retryDelayMs` can be passed when the defaults are not suitable. On macOS, the host owns and prepares the Apple Native SDK bridge before Electron starts.

## Preload integration

Use `@cloudcare/electron-native-adapter/preload/install` when composing an existing preload, or `@cloudcare/electron-native-adapter/preload/standalone` as a sandbox-compatible standalone preload. Both expose only the narrow `FTWebViewJavascriptBridge` API required by Browser RUM; they do not expose arbitrary Electron IPC.
