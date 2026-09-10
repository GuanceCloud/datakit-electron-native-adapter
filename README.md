# `@cloudcare/electron-native-adapter`

CloudCare's Electron Native Adapter connects the Browser RUM SDK running in an Electron Renderer to a CloudCare Native SDK on macOS and Windows.

This package is a CommonJS JavaScript adapter. Windows x64 binaries ship directly in this package under `native/win32-x64`. There is one npm package and one publish operation. In full mode, Electron owns the platform Native SDK through `managed` mode. In mixed mode, the Native host owns the SDK and Electron connects through `external` mode.

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

Managed runtime selection is: explicit `native.directory` (or `startFullMode({ nativeDirectory })`), then `process.resourcesPath/native` if present, then this package's `native/win32-x64` directory. Invalid explicit or staged paths fail without fallback. An explicit legacy build directory may omit the npm manifest; the existing protocol/capabilities handshake is always validated. Default npm runtimes also validate version, architecture, protocol and SHA-256 before starting.

The bundled Windows runtime remains available with `npm install --omit=optional`. Only Windows managed mode resolves and starts it. macOS consumers also download these bytes but do not execute them; the existing Darwin build/CLI remains unchanged. Mixed Mode still uses its application-owned native host. The bundled runtime covers x64 only; other architectures require an explicit compatible build.

`spawn()` needs real files outside ASAR. After packaging, stage the complete runtime into the application's resources directory:

```js
const { stageWindowsRuntime } = require("@cloudcare/electron-native-adapter/packaging/windows");
stageWindowsRuntime({ resourcesDirectory: "release/MyApp-win32-x64/resources", arch: "x64" });
```

The destination `resources/native` must be empty. This helper copies bytes without changing signatures and validates the manifest. It also accepts `nativeDirectory` for local native development. For an older manifest-less override, continue passing the explicit directory at application startup. See [Electron ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

### Preparing local Windows packages

The source package remains `private: true` and `0.0.0-local`. The pack script creates one publishable package directory with an explicit npm version and audited native export. It never changes the source version, runs install scripts, or publishes. C++ sources stay in the Windows SDK repository. Run the scripts from an actual adapter Git checkout so both source revisions can be recorded.

```powershell
# Run the Windows SDK's build/export-electron-runtime.ps1 first; output must be empty.
npm run pack:windows -- --runtime ../runtime-export --version 0.0.0-local.2 --output artifacts/local --allow-dirty
npm run verify:windows:tarballs -- artifacts/local
```

`--allow-dirty` is only for local validation. Pack/release reject dirty native or adapter source by default. The single tarball contains the JS adapter and exactly EXE, DLL, runtime manifest and native LICENSE under `native/win32-x64`; no PDB or native test hosts. The manifest records the independent native SDK version, source commit/dirty status, Release/x64, protocol 1, CRT imports, signatures, and hashes calculated after optional signing. `pack-report.json` schema 2 records both source revisions and one `package` result with npm file list and integrity. `main/` is the prepared package directory. Archive it together with the tarball and report for publish preflight. The verifier installs this single tarball offline with an empty cache, both normally and with `--omit=optional`, and exercises bootstrap, startFullMode and explicit overrides without any registry download.

Before a real release, choose the npm version/registry/access/tag, review source and licenses, verify on target Windows systems, and configure signing if required by release policy. Windows export accepts `-SignFile` and `-RequireSignature`; local unsigned builds are supported. The single npm version and native SDK version are independent, as are NuGet and vcpkg releases. Publish the one verified tarball. No CI remote, account or credentials are assumed, and no publish runs as part of install/build/check/pack.

The explicit release helper is `npm run publish:windows -- --directory <pack-output> --registry <https-registry> --tag <dist-tag> --access <public-or-restricted>`. Without `--execute` it only validates clean provenance, versions and tarball integrity. With separately authorized `--execute`, it calls npm publish once for that exact tarball. Old dual-package reports and `--platform-already-published` are rejected. If a network failure leaves the result uncertain, query the package/version registry integrity and compare it with the report before retrying; never overwrite an existing version. This helper does not select credentials or signing identity.

On macOS, run the following command from the Electron application root:

```sh
npx ft-electron-native managed
```

The command downloads and verifies a precompiled Universal runtime for Apple Silicon and Intel Macs in `.cloudcare/native/darwin/runtime`. Pass this directory as `native.directory` during development. When packaging the application, copy the complete directory outside ASAR and sign its Native binary with the application.

The CLI does not compile Native code and does not require Xcode, Swift, or Node headers. Installing this npm package does not download or load a Native runtime. Only full (managed) mode uses the command; mixed (external) mode must use the Native host SDK without installing a second SDK runtime.

The pinned SDK release must include Electron runtime assets before the default download can succeed. For local development or offline installation, use an archive generated by the Native SDK and its adjacent SHA-256 sidecar:

    npx ft-electron-native managed --runtime-archive /path/to/guance-electron-runtime-1.6.8-alpha.3-darwin-universal.tar.gz

See [runtime installation options](native/darwin/README.md) for versions, architectures, mirrors, and caching.

## Mixed mode

Use `native.mode: "external"` when a Native host owns the platform Native SDK. Do not pass `native.settings`, because SDK configuration belongs to the Native host.

On Windows, the host exposes a named-pipe bridge; `pipeName`, `timeoutMs`, and `retryDelayMs` can be passed when the defaults are not suitable. On macOS, the host owns and prepares the Apple Native SDK bridge before Electron starts.

## Preload integration

Use `@cloudcare/electron-native-adapter/preload/install` when composing an existing preload, or `@cloudcare/electron-native-adapter/preload/standalone` as a sandbox-compatible standalone preload. Both expose only the narrow `FTWebViewJavascriptBridge` API required by Browser RUM; they do not expose arbitrary Electron IPC.
