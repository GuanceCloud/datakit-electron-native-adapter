# macOS Native Runtime Build

This npm repository contains only JavaScript build orchestration for the macOS
Native runtime. The Apple Native SDK owns the Objective-C bridge header and
implementation, the Objective-C++ Node-API addon source, and the SwiftPM
`GuanceElectronNative` static library product.

## Customer command

Installing this npm package exposes `ft-electron-native` through the
application's local `node_modules/.bin` directory. From the application root,
build the Electron-owned runtime with:

```sh
npx ft-electron-native managed
```

This command defaults to universal `arm64` plus `x86_64` output. It writes all
customer build state below `.cloudcare/native/darwin` and publishes the runtime to
`.cloudcare/native/darwin/runtime`; it does not modify `node_modules`. Use
`--arch current`, `--arch arm64`, or `--arch x64` for a thin build. External
mode has no command because the Native host owns the SDK and bridge lifecycle.

## Native SDK source

The customer CLI fetches `https://github.com/GuanceCloud/datakit-ios.git` at
the exact `1.6.8-alpha.3` ref into the application's ignored
`.cloudcare/native/darwin/.build` cache. The selected Native SDK source must
expose:

```text
Package.swift                                  # GuanceElectronNative product
Sources/ElectronNative/Bridge/Public/GuanceElectronBridge.h
Sources/ElectronNative/NodeAddon/guance_electron.mm
```

During Native SDK development, select an existing checkout without changing or
persisting the package dependency:

```sh
GUANCE_NATIVE_SDK_ROOT=/path/to/datakit-ios npx ft-electron-native managed --arch current
```

The equivalent CLI option is `--sdk-root /path/to/datakit-ios`. Repository and
ref overrides are available through `GUANCE_NATIVE_SDK_REPOSITORY`,
`GUANCE_NATIVE_SDK_REF`, `--sdk-repository`, and `--sdk-ref`. A release must use
an immutable ref containing the required product and source paths. Until
`1.6.8-alpha.3` is published, use the local checkout override for development.

Set `GUANCE_ELECTRON_NODE_HEADERS` when `node_api.h` is not installed in a
standard Node or Homebrew location.

## Output

The customer command writes generated artifacts to
`.cloudcare/native/darwin/runtime`:

```text
runtime/
├── guance_electron.node
├── GuanceSDK__GuanceSDKCore.bundle/
└── runtime-manifest.json
```

The build links the Native SDK static product into the Node-API addon with
`-Wl,-ObjC` so SDK Categories used by automatic instrumentation are retained.
Customers do not configure linker flags. Package the runtime directory outside
ASAR and sign the addon with the application's distribution identity.
