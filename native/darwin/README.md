# macOS Precompiled Runtime Installation

The Apple Native SDK owns and publishes the Objective-C bridge, Node-API addon,
Native SDK code, resource bundles, runtime manifest, archive, and checksum. This
npm package contains the JavaScript adapter and installation code; it does not
ship macOS Native binaries or compile Native SDK source on the customer machine.

## Mode boundary

- Full (`managed`) mode explicitly installs the standalone runtime and lets
  Electron own the Native SDK lifecycle.
- Mixed (`external`) mode uses the Native host SDK through its bridge. Skip automatic
  installation with `GUANCE_NATIVE_SKIP_DOWNLOAD=1` and do not load the managed runtime: it contains a statically
  linked copy of the SDK and must not coexist with another SDK implementation
  in the same process.

Published npm packages run postinstall by default using the packaged Apple SDK tag. Set
`GUANCE_NATIVE_RUNTIME_ARCHIVE` to install the same Release archive plus its adjacent
`.sha256` offline instead. Set `GUANCE_NATIVE_SKIP_DOWNLOAD=1` explicitly for external-only
apps or npm pipeline validation. There is no source-build fallback; a missing asset or
failed validation reports an error.

## Customer command

Installing this npm package exposes `guance-electron-native` through the
application's local `node_modules/.bin` directory. From the Electron application
root, install a published Universal runtime with an explicit Native SDK version:

```sh
npx guance-electron-native --sdk-version <version>
```

The explicit CLI requires a Native SDK version; postinstall instead uses the default tag
configured in the published npm package. The installer downloads these two assets from
the matching Native SDK GitHub Release:

```text
guance-electron-runtime-<version>-darwin-universal.tar.gz
guance-electron-runtime-<version>-darwin-universal.tar.gz.sha256
```

The CLI validates SHA-256, archive entries, SDK version, architecture, manifest
format, and runtime file hashes before replacing the installed directory.
Downloads are cached under `.cloudcare/native/darwin/.cache` and rechecked on
reuse. A failed download or validation leaves the existing runtime intact.

Use a trusted HTTPS mirror when required:

```sh
npx guance-electron-native --sdk-version <version> \
  --download-base-url https://downloads.example.com/native
```

For local validation, provide an archive and its adjacent `.sha256` sidecar. The
specified version must match the archive manifest:

```sh
npx guance-electron-native --sdk-version <version> \
  --runtime-archive /path/to/guance-electron-runtime.tar.gz
```

The mirror and archive options can also be provided through
`GUANCE_NATIVE_RUNTIME_DOWNLOAD_BASE_URL` and `GUANCE_NATIVE_RUNTIME_ARCHIVE`.
The Native SDK version must always be passed with `--sdk-version`.

## Native SDK development

Generate the archive from the Native SDK repository, which owns the build tools:

```sh
node scripts/build-electron-runtime.mjs
```

Then install that archive in the Electron application with its manifest version:

```sh
npx guance-electron-native --sdk-version <version> \
  --runtime-archive /path/to/guance-electron-runtime-<version>-darwin-universal.tar.gz
```

The previous adapter `build:native:macos:*` scripts and `--sdk-root`, `--sdk-ref`,
`--sdk-repository`, and `--debug` customer options have been removed. Source
compilation and debugging belong to the Native SDK build command.

## Installed runtime

```text
.cloudcare/native/darwin/runtime/
  guance_electron.node
  GuanceSDK__GuanceSDKCore.bundle/
  runtime-manifest.json
```

Pass this explicit CLI output as `native.directory`. Postinstall uses the equivalent
path inside the npm package, which managed mode resolves automatically. The addon statically contains the
Native SDK and targets Node-API 8. The manifest's minimum macOS version describes
the addon; the selected Electron version may require a newer macOS version.
Copy the complete directory outside ASAR when packaging, and sign the addon
with the application's distribution identity.
