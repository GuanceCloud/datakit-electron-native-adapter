# macOS Precompiled Runtime Installation

The Native SDK owns all Native source and the scripts that build, verify, and
package the Electron managed runtime. This npm package contains JavaScript
adapter and installation code only; it neither ships Native binaries nor
compiles Native SDK source.

## Mode boundary

- Full (`managed`) mode explicitly installs the standalone runtime and lets
  Electron own the Native SDK lifecycle.
- Mixed (`external`) mode uses the Native host SDK through its bridge. Do not
  install or load the managed runtime in this mode: it contains a statically
  linked copy of the SDK and must not coexist with another SDK implementation
  in the same process.

There is no npm install/postinstall download and no automatic source-build
fallback. A missing asset or failed validation reports an error.

## Customer command

From the Electron application root:

    npx ft-electron-native managed

The default is Native SDK `1.6.8-alpha.3`. Every release uses one Universal
runtime containing arm64 and x86_64.
The CLI downloads these assets from that GitHub Release:

    guance-electron-runtime-1.6.8-alpha.3-darwin-universal.tar.gz
    guance-electron-runtime-1.6.8-alpha.3-darwin-universal.tar.gz.sha256

The release must publish these assets before the default download can succeed.
The CLI validates SHA-256, archive entries, SDK version, architecture, manifest
format, and runtime file hashes before replacing the installed directory.
Downloads are cached under `.cloudcare/native/darwin/.cache` and rechecked on
reuse. A failed download or validation leaves the existing runtime intact.

Options:

- `--sdk-version <version>`: select a compatible SDK release. The default is pinned
  by the adapter; version overrides do not imply adapter API compatibility.
- `--download-base-url <https-url>`: use a mirror with the same
  `<tag>/<asset-name>` layout. The default base is
  `https://github.com/GuanceCloud/datakit-ios/releases/download`.
- `--runtime-archive <path>`: install a local archive and its adjacent `.sha256`
  sidecar, without network access. Specify a matching version if the archive
  differs from the default.

Equivalent environment variables are `GUANCE_NATIVE_SDK_VERSION`,
`GUANCE_NATIVE_RUNTIME_DOWNLOAD_BASE_URL`, and `GUANCE_NATIVE_RUNTIME_ARCHIVE`.

## Native SDK development

Generate archives from the Native SDK repository, which owns the build tools:

    node scripts/build-electron-runtime.mjs

Then install that archive in the Electron application:

    npx ft-electron-native managed --runtime-archive /path/to/guance-electron-runtime-1.6.8-alpha.3-darwin-universal.tar.gz

The previous adapter `build:native:macos:*` scripts and `--sdk-root`, `--sdk-ref`,
`--sdk-repository`, and `--debug` customer options have been removed. Source
compilation and debugging belong to the Native SDK build command.

## Installed runtime

    .cloudcare/native/darwin/runtime/
      guance_electron.node
      GuanceSDK__GuanceSDKCore.bundle/
      runtime-manifest.json

Pass this directory as `native.directory`. The addon statically contains the
Native SDK and targets Node-API 8. The manifest's minimum macOS version describes
the addon; the selected Electron version may require a newer macOS version.
Copy the complete directory outside ASAR when packaging, and sign the addon
with the application's distribution identity.
