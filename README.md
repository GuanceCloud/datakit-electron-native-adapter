# `@cloudcare/electron-native-adapter`

CloudCare's Electron Native Adapter connects the Browser RUM SDK running in an Electron Renderer to a CloudCare Native SDK on macOS and Windows.

This package is a CommonJS JavaScript adapter and does not contain generated Native binaries. In full mode, Electron owns the platform Native SDK through `managed` mode. In mixed mode, the Native host owns the SDK and Electron connects through `external` mode.

## Support status

- Windows managed mode: supported. The Adapter owns the Windows Native Bridge process.
- macOS managed mode: supported. The Adapter owns the macOS Native SDK through its Node-API addon.
- Windows external mode: supported. The application owns the Windows Native SDK and exposes its named-pipe bridge.
- macOS external mode: supported. The Native host owns the macOS Native SDK and its Electron bridge.
- Linux: not supported.

Electron `43.x` is the currently verified Electron line. Node.js `22.12` or newer is required.

## Preferred API

Full mode uses the same `managed` API and `native.settings` object on macOS and Windows.

```js
const { bootstrap } = require("@cloudcare/electron-native-adapter");

const client = await bootstrap({
  electron: require("electron"),
  native: {
    mode: "managed",
    directory: nativeRuntimeDirectory,
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

Use `datawayUrl` with `clientToken` instead of `datakitUrl` when reporting through DataWay. Sampling settings use the cross-platform `0..1` range. See the [macOS managed settings mapping](docs/macos-managed-settings-mapping.md) for how the shared settings are applied by the Apple Native SDK.

`bootstrap()` returns one client with normalized `capabilities`, `attachWindow()`, `detachWindow()`, `updateWindow()`, `transportState`, and idempotent `stop()` methods.

## Native runtime

Windows applications install the managed Native runtime with the Windows Native SDK and pass its installed directory as `native.directory`.

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
