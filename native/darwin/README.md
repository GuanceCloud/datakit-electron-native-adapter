# macOS Native Runtime Source

This directory owns the Electron-specific source and build chain for the macOS
Full Mode runtime. Generated artifacts are deliberately excluded from Git.

## Source layout

- `NativeBridge` exposes the Objective-C C ABI over the Guance Apple SDK.
- `addon/guance_electron.mm` exposes that ABI to Electron through Node-API.
- `Package.swift` builds the dynamic Objective-C bridge and links the
  `GuanceElectronWebView` SwiftPM product.
- `scripts` builds and verifies current-architecture or universal runtime
  artifacts.

The complete Apple SDK source remains in the `datakit-ios` package. SwiftPM
resolves it from `https://github.com/GuanceCloud/datakit-ios.git` at the exact
`1.6.8-alpha.1` tag. Swift tools 5.6 or newer is required for exact-version
dependency declarations.

## Build

From the repository root:

```sh
npm run build:native:macos:universal
npm run verify:native:macos
```

For faster local iteration on the current machine architecture:

```sh
npm run build:native:macos
```

Set `GUANCE_ELECTRON_NODE_HEADERS` when Node-API headers are not installed in a
standard Node or Homebrew location.

## Output

Builds write the following ignored files to `runtime`:

```text
runtime/
├── guance_electron.node
├── libGuanceElectronNative.dylib
└── GuanceSDK__GuanceSDKCore.bundle/
```

The addon and dylib must remain adjacent at runtime because the addon resolves
the bridge through `@loader_path`. Application release packaging must place the
runtime outside ASAR and sign the final nested binaries with the application's
distribution identity.
