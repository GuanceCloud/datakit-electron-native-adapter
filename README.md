# Guance Electron Native Adapter

Guance Electron Native Adapter connects the Browser RUM SDK running in an Electron Renderer to the Guance Native SDK on macOS and Windows.

This CommonJS adapter is one npm package. npm installation downloads the current platform's runtime from its Native SDK GitHub Release by default. A supplied offline SDK archive takes precedence over downloading. In managed mode Electron owns the Native SDK; in external mode the native host owns it.

## Support status

- Windows managed mode: supported. The Adapter owns the Windows Native Bridge process.
- macOS managed mode: supported. The Adapter owns the macOS Native SDK through its Node-API addon.
- Windows external mode: supported. The application owns the Windows Native SDK and exposes its named-pipe bridge.
- macOS external mode: supported. The Native host owns the macOS Native SDK and its Electron bridge.
- Linux: not supported.

Windows compatibility baselines are Electron `22.3.27` (Windows 7 SP1 through Windows 11) and `43.x` (Windows 10+). The npm peer range is `^22.3.27 || 43.x`; intermediate Electron majors are not yet validated. Electron 22 is the legacy compatibility baseline and is end-of-life; see the [upstream support notice](https://www.electronjs.org/blog/electron-22-0). Native runtime compatibility must also be validated on each target OS and architecture; the legacy Windows 7 baseline is not an ARM64 support claim. The macOS managed backend uses the same declared Electron range and a Universal SDK runtime; each Electron/architecture combination still requires native release acceptance.

The adapter JavaScript runtime baseline is Node.js `16.17.1`, as embedded in Electron 22. Installing the npm package and running its SDK installer require a separate Node.js `18+` toolchain (the archive dependency requires it); these installer dependencies are not loaded by the adapter API. Development and `npm run check` require Node.js `22.12` or newer; users of a packaged application do not need a separate Node.js installation.

## Preferred API

Full mode uses the same `managed` API and `native.settings` object on macOS and Windows.

```js
const { bootstrap } = require("@cloudcare/electron-native-adapter");

const client = await bootstrap({
  electron: require("electron"),
  native: {
    mode: "managed",
    // Automatic npm installs resolve their runtime by default.
    // directory: nativeRuntimeDirectory, // Optional explicit CLI/local override.
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

Installing a published npm package runs postinstall and downloads the current platform's runtime by default; it never compiles or loads native code during installation. Only managed Full Mode uses this runtime. External-only consumers should set `GUANCE_NATIVE_SKIP_DOWNLOAD=1` to avoid installing an unused SDK.

| Target | GitHub Release source | Runtime |
| --- | --- | --- |
| macOS | [datakit-ios](https://github.com/GuanceCloud/datakit-ios/releases) | Universal arm64 + x86_64 |
| Windows | [datakit-windows-desktop](https://github.com/GuanceCloud/datakit-windows-desktop/releases) | x64 / x86 / arm64 Bridge EXE and Native DLL |

The npm, Apple SDK and Windows SDK versions are independent. Release packages carry fixed per-platform SDK tags in `package.json.nativeRuntime`; no `latest` lookup is used. Private source checkouts and unsupported hosts skip automatic installation. A download or validation failure on a supported host fails npm installation.

### Default npm installation

```sh
npm install @cloudcare/electron-native-adapter@alpha
```

For an offline native runtime, set the archive before npm installation (POSIX shell example):

```sh
GUANCE_NATIVE_RUNTIME_ARCHIVE=/absolute/path/runtime.tar.gz npm install @cloudcare/electron-native-adapter@alpha
```

Keep `runtime.tar.gz.sha256` beside it. Local input takes precedence and never falls back to a network download on failure. Fully offline npm installation also requires the npm tarball and its dependency cache, then `npm install --offline <adapter.tgz>`.

`GUANCE_NATIVE_SKIP_DOWNLOAD=1` explicitly skips native installation for external-only apps or npm pipeline validation. `GUANCE_NATIVE_SDK_VERSION`, `GUANCE_NATIVE_RUNTIME_ASSET_NAME`, and `GUANCE_NATIVE_RUNTIME_TARGET` override the packaged SDK tag, Windows filename, and target. Do not confuse these with the npm version. On PowerShell, set the corresponding `$env:VARIABLE` before running npm. `--ignore-scripts` also suppresses postinstall; use the CLI below afterwards.

The following explicit CLI commands remain available; run them from the Electron application root.

### Remote installation

```sh
# macOS; preserve the SDK's exact tag spelling, including v if present.
npx guance-electron-native --sdk-version <apple-sdk-tag>

# Windows; preserve the SDK tag, including nuget_ or vcpkg_ if present.
npx guance-electron-native --sdk-version <windows-sdk-tag>
```

The CLI and postinstall select the current Node platform and architecture. Node/Electron `ia32` maps to SDK `x86`. To install for an Electron architecture different from the installing Node process, set `GUANCE_NATIVE_RUNTIME_TARGET=win32-x86` (or `win32-x64` / `win32-arm64`) during npm installation, or pass the CLI target explicitly. `stageWindowsRuntime({ arch })` accepts `x64`, `x86` (also `ia32`), and `arm64`; pass the target explicitly for cross-architecture packaging. For cross-platform packaging, add `--target darwin-universal` or `--target win32-x64`, `--target win32-x86`, or `--target win32-arm64`. Windows defaults to `guance-electron-runtime-<version>-win32-<arch>.tar.gz`; use `--asset-name` to override a fixed or legacy filename. For Windows tags `nuget_<version>` and `vcpkg_<version>`, the download URL retains the full tag and the filename/manifest use its version suffix. The stream suffix follows the SDK's stable, `alpha.N`, or `beta.N` format. Plain and `v`-prefixed versions remain supported. A tag must actually contain the runtime assets; a NuGet/vcpkg tag alone does not imply they were uploaded.

macOS requests `guance-electron-runtime-<version>-darwin-universal.tar.gz`. All targets request an adjacent `<archive-name>.sha256` asset. The archive's SDK version, architecture, manifest and file hashes are validated before installation. HTTPS mirrors are supported through `--download-base-url <base>` or `GUANCE_NATIVE_RUNTIME_DOWNLOAD_BASE_URL`; the installer appends `/<sdk-tag>/<filename>`.

### Offline installation

Download the same SDK Release asset and its checksum in advance, keep them together, and run:

```sh
npx guance-electron-native --sdk-version <sdk-tag> --runtime-archive /path/to/runtime.tar.gz
```

The checksum must be `/path/to/runtime.tar.gz.sha256`. Offline installation does not access the network and does not require `--asset-name`. The archive path can also be supplied with `GUANCE_NATIVE_RUNTIME_ARCHIVE`. Install the npm package and its dependencies beforehand; otherwise `npx` itself may contact npm. This command installs a native runtime, not the npm package.

Supported archives are currently `.tar.gz`, not ZIP or GitHub-generated source archives. macOS preserves the SDK's top-level `runtime/` directory and manifest format. Windows accepts either top-level `runtime/` or a flat export with EXE, DLL, `runtime-manifest.json`, and optional LICENSE; it validates the existing SDK export schema (Release with matching x64/x86/arm64 PE architecture, protocol, source provenance, CRT metadata and binary hashes). The SDK's `build/pack-electron-runtime.ps1` produces the version-derived archive and adjacent checksum from its existing exporter. Release upload remains an SDK publication step; local acceptance does not establish that a public asset is available.

Postinstall stores `.cloudcare/native/darwin/runtime` or `.cloudcare/native/win32-<arch>/runtime` inside the installed npm package, and managed mode resolves it automatically. Explicit CLI installs use those paths under the invoking application; pass the printed output as `native.directory`. Staged `resources/native` takes precedence over package-local runtime files. Verified archives are cached under each platform's `.cache`, keyed by release URL, and rechecked on reuse. Failed downloads or validation leave the previous installation intact. The installer does not compile Native SDK source.

Windows applications require the Microsoft Visual C++ v14 Redistributable for the runtime architecture and Windows Universal CRT; this package does not redistribute them.

### Application packaging

Copy the complete runtime outside ASAR:

```js
const { stageWindowsRuntime } = require("@cloudcare/electron-native-adapter/packaging/windows");
stageWindowsRuntime({
  resourcesDirectory: "release/MyApp-win32-x64/resources",
  nativeDirectory: ".cloudcare/native/win32-x64/runtime",
  arch: "x64",
});

const { stageMacOSRuntime } = require("@cloudcare/electron-native-adapter/packaging/macos");
stageMacOSRuntime({
  resourcesDirectory: "release/MyApp.app/Contents/Resources",
  nativeDirectory: ".cloudcare/native/darwin/runtime",
  arch: "arm64",
});
```

The destination `resources/native` must be empty. Set the packaged application's `native.directory` to `path.join(process.resourcesPath, "native")`. Sign the macOS addon with the application's distribution identity after staging. Re-signing changes its hashes; runtime startup relies on the application-owned directory and native handshake rather than the original downloaded checksum. Application code signing is responsible for the shipped application's integrity.

### npm packaging and publication

Native builds and Release uploads belong to the two SDK repositories, not this adapter. The adapter source remains `private: true` and `0.0.0-local`. Generate one JavaScript-only npm candidate with an independent version:

```sh
npm run pack:release -- --version 0.1.0-alpha.1 --macos-sdk-version <apple-tag> --windows-sdk-version <windows-tag> --output artifacts/release
npm run verify:release -- --directory artifacts/release
npm run publish:release -- --directory artifacts/release --registry https://registry.npmjs.org/ --tag alpha --access public
```

Packing requires fixed SDK tags, but no native archives, descriptors or network checks. `--windows-sdk-version` records the same SDK tag and a distinct derived filename for all three Windows targets. Each target can configure `nativeRuntime.targets["win32-<arch>"].assetName`; the legacy `--windows-asset-name` option overrides x64 only. A filename-only override retains the configured SDK tag; updating the SDK tag regenerates a previously derived filename and retains a custom fixed filename. Archive `main/`, the npm tarball, `pack-report.json` (schema 5) and the verification report. Source provenance must be clean for publication; `--allow-dirty` is only for local pack/verify experiments.

`verify:release` installs the actual npm tarball (including default postinstall), then checks CLI help and adapter import. Add `--skip-runtime` explicitly to test only the npm pipeline. It may download normal npm dependencies; `--offline` controls npm's cache, not the SDK downloader. To prevent SDK network access, supply `GUANCE_NATIVE_RUNTIME_ARCHIVE` or use `--skip-runtime`. This verifier does not execute native binaries or establish Native SDK runtime compatibility.

Without `--execute`, `publish:release` only validates local package metadata, provenance and integrity. Append `--execute` to publish that exact tarball. SDK URLs are not a prerequisite; the old `--local-only` flag is accepted but no longer changes this behavior. The helper rejects prereleases tagged `latest`, checks existing npm integrity before retrying, and verifies npm integrity after publication.

For an alpha intended only to validate the npm pipeline, use `pack:release --pipeline-only` instead of the SDK defaults if those versions are not known, and `verify:release --skip-runtime`. This exception is restricted to prerelease versions. The resulting package retains postinstall; consumers must explicitly set `GUANCE_NATIVE_SKIP_DOWNLOAD=1` or supply the missing SDK settings. It does not silently disable the default behavior. Such an alpha can be published before Native SDK assets are ready. This does not establish that managed mode works: test remote and offline installation plus native/Electron behavior separately on each supported platform before declaring a version integration-ready.

### Windows native acceptance

On a Windows machine with matching Node, Electron and runtime architectures and the CRT prerequisites, verify an actual npm candidate against a trusted SDK archive:

```powershell
npm run verify:windows -- --directory artifacts/release --runtime-archive C:/sdk/runtime.tar.gz --offline --electron C:/tools/electron/electron.exe
```

This runs postinstall in a fresh npm consumer using the packed SDK tag, checks managed startup and events through the real Bridge EXE, stages the runtime outside ASAR, and exercises a sandboxed Renderer through Preload/Main using the optional `--electron` executable. It writes `verify-windows-<timestamp>.json` with npm integrity, SDK source and separate native/Electron results. Repeat with Electron 22 and 43. Without `--electron`, only native acceptance runs. `--sdk-version` explicitly overrides the packed tag; `--allow-dirty` accepts local development artifacts. `--offline` requires a prefilled npm dependency cache. This command executes native code; use binaries built from your SDK checkout or a trusted release.

## Mixed mode

Use `native.mode: "external"` when a Native host owns the platform Native SDK. Do not pass `native.settings`, because SDK configuration belongs to the Native host.

On Windows, the host exposes a named-pipe bridge; `pipeName`, `timeoutMs`, and `retryDelayMs` can be passed when the defaults are not suitable. On macOS, the host owns and prepares the Apple Native SDK bridge before Electron starts.

## Preload integration

Use `@cloudcare/electron-native-adapter/preload/install` when composing an existing preload, or `@cloudcare/electron-native-adapter/preload/standalone` as a sandbox-compatible standalone preload. Both expose only the narrow `FTWebViewJavascriptBridge` API required by Browser RUM; they do not expose arbitrary Electron IPC.
