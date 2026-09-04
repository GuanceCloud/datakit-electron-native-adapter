# macOS examples

These are the full OrbitDesk examples adapted to the current public API. They share the same Browser RUM behavior and demonstrate the two supported Native SDK ownership models.

| Directory | Adapter mode | Native SDK owner |
| --- | --- | --- |
| `electron/` | `managed` | Electron Main |
| `native/` | `external` | Swift AppKit host |

## Prerequisites

- macOS 13 or newer
- Node.js 22.12 or newer
- Xcode Command Line Tools with Swift 5.9 or newer
- Electron dependencies installed with `npm run example:macos:install` from the repository root

Copy each `.env.example` to `.env` and fill in the Browser and Native RUM intake values before interactive testing. The committed example files contain no credentials.

The root install command disables the optional npm audit request and uses `https://npmmirror.com/mirrors/electron/` only for the large Electron binary. It does not change the global npm registry. If npm itself reports `ENOTFOUND`, retry with a one-command registry override:

```sh
npm_config_registry=https://registry.npmjs.org npm run example:macos:install
```

## Electron-owned managed mode

Build the repository-owned macOS runtime, then launch the Electron example:

```sh
npm run build:native:macos
npm run example:macos:managed
```

The application uses Electron for its entire UI. The Electron Main process maps environment variables to the public `native.settings` object and passes it to `bootstrap()`. Renderer RUM data is forwarded through the Native SDK bridge, while Native lifecycle and launch Actions remain under the Apple SDK's automatic collection. For packaging, `npm run package:dir --prefix examples/macos/electron` copies the generated SDK runtime outside ASAR.

## Native-owned external mode

Launch the Swift host and its Electron child process:

```sh
npm run example:macos:external
```

The Swift package resolves `https://github.com/GuanceCloud/datakit-ios.git` at exactly `1.6.8-alpha.1`. The host initializes the Native SDK, starts `FTElectronBridgeServer`, and injects one-time socket credentials into its Electron child. Electron does not receive `native.settings` in this mode.

## Automated startup check

```sh
npm run example:macos:smoke
```

This builds both Renderers, starts both ownership models with local placeholder intake values, verifies that the adapter and Renderer become ready, and exits automatically.
