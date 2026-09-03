# `@cloudcare/electron-native-adapter`

CloudCare's Electron Native Adapter connects the Browser RUM SDK running in an Electron Renderer to a CloudCare native desktop SDK.

This package is a CommonJS JavaScript adapter, not a Node Native Addon. It does not contain native binaries. Install the Windows native runtime separately with vcpkg and pass its installed directory to managed mode, run the Windows native SDK in the host application and connect with external mode, or pass the macOS SDK's embedded bridge module to embedded mode.

## Support status

- Windows managed mode: supported. The adapter owns the Windows Native Bridge process.
- Windows external mode: supported. The application owns the Windows Native SDK and exposes its named-pipe bridge.
- macOS embedded mode: supported with the application-owned Guance macOS Native SDK and `GuanceElectronBridge.node`.
- Linux: not supported.

Electron `43.x` is the currently verified Electron line. Node.js `22.12` or newer is required.

## Preferred API

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

`bootstrap()` returns one client with normalized `capabilities`, `attachWindow()`, `detachWindow()`, `updateWindow()`, and idempotent `stop()` methods. On Windows, set `native.mode` to `"external"` and provide `pipeName`, `timeoutMs`, or `retryDelayMs` to connect to an application-owned bridge.

`startFullMode()` and `connectMixedMode()` remain compatibility wrappers for the first alpha. New integrations should use `bootstrap()`.

On macOS, initialize `GuanceSDK`, `GuanceSessionReplay`, and
`GuanceElectronWebView` in the host application before Electron navigation,
then pass the SDK-distributed bridge to embedded mode:

```js
const { bootstrap } = require("@cloudcare/electron-native-adapter");

const client = await bootstrap({
  electron: require("electron"),
  native: {
    mode: "embedded",
    bridge: require("./GuanceElectronBridge.node"),
  },
  autoAttach: true,
  onNativeCommand(command) {
    // Optional observation hook for validated Native-to-Electron commands.
  },
});
```

The embedded backend owns macOS window handles and Session Replay slot IDs.
Use `updateWindow(windowOrWebContents, { visible, zIndex, bounds })` for layout
changes. When attaching a BrowserView/WebContents rather than a BrowserWindow,
also provide `{ browserWindow }` in its metadata so the backend can resolve the
host window without exposing AppKit objects.

## Preload integration

Use `@cloudcare/electron-native-adapter/preload/install` when composing an existing preload, or `@cloudcare/electron-native-adapter/preload/standalone` as a sandbox-compatible standalone preload. Both expose only the narrow `FTWebViewJavascriptBridge` API required by Browser RUM; they do not expose arbitrary Electron IPC.

## Local verification

The package intentionally remains `private` at version `0.0.0-local` during the local-validation phase.

```powershell
npm install
npm run check
npm pack --dry-run --json
```

Native EXE, DLL, and `.node` files are intentionally absent from the npm tarball.
