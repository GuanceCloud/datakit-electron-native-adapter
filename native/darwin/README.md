# macOS Native Runtime Build

This npm repository contains only JavaScript build orchestration for the macOS
Native runtime. The Apple Native SDK owns the Objective-C bridge header and
implementation, the Objective-C++ Node-API addon source, and the SwiftPM
`GuanceElectronNative` static library product.

## Managed build

Managed mode builds the Native runtime used when Electron owns SDK startup and
shutdown:

```sh
npm run build:native:macos:managed
```

`build:native:macos` is an alias for the current-architecture managed build.
Use `build:native:macos:universal` to produce `arm64` and `x86_64` slices.
External mode has no Native build command because the Native host owns the SDK
and exposes `FTElectronBridgeServer`.

## Native SDK source

Managed builds fetch `https://github.com/GuanceCloud/datakit-ios.git` at the
exact `1.6.8-alpha.3` ref into the ignored `native/darwin/.build` cache. The
selected Native SDK source must expose:

```text
Package.swift                                  # GuanceElectronNative product
Sources/ElectronNative/Bridge/Public/GuanceElectronBridge.h
Sources/ElectronNative/NodeAddon/guance_electron.mm
```

During Native SDK development, select an existing checkout without changing or
persisting the package dependency:

```sh
GUANCE_NATIVE_SDK_ROOT=/path/to/datakit-ios npm run build:native:macos
```

The equivalent CLI option is `--sdk-root /path/to/datakit-ios`. Repository and
ref overrides are available through `GUANCE_NATIVE_SDK_REPOSITORY`,
`GUANCE_NATIVE_SDK_REF`, `--sdk-repository`, and `--sdk-ref`. A release must use
an immutable ref containing the required product and source paths. Until
`1.6.8-alpha.3` is published, use the local checkout override for development.

Set `GUANCE_ELECTRON_NODE_HEADERS` when `node_api.h` is not installed in a
standard Node or Homebrew location.

## Output

Builds write ignored artifacts to `native/darwin/runtime`:

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
