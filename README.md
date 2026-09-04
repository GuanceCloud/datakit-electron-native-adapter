# `@cloudcare/electron-native-adapter`

CloudCare's Electron Native Adapter connects the Browser RUM SDK running in an Electron Renderer to a CloudCare native desktop SDK.

This package exposes a CommonJS JavaScript adapter and keeps generated native binaries out of Git and npm. The repository also owns the source and build chain for the macOS Node-API addon and Objective-C bridge under `native/darwin`. Build or install the matching runtime and pass its directory to the Electron-owned mode, or run the native SDK in the host application and connect with external mode.

## Support status

- Windows managed mode: supported. The adapter owns the Windows Native Bridge process.
- Windows external mode: supported. The application owns the Windows Native SDK and exposes its named-pipe bridge.
- macOS managed mode: supported. Electron owns the macOS Native SDK through its Node-API addon.
- macOS external mode: supported. A Native host owns the SDK and exposes an authenticated Unix domain socket through `FTElectronBridgeServer`.
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

`bootstrap()` returns one client with normalized `capabilities`, `attachWindow()`, `detachWindow()`, `updateWindow()`, and idempotent `stop()` methods. Set `native.mode` to `"external"` for an application-owned bridge. Windows accepts `pipeName`, `timeoutMs`, and `retryDelayMs`; macOS reads the Native-generated socket credentials described below.

`startFullMode()` and `connectMixedMode()` remain compatibility wrappers for the first alpha. New integrations should use `bootstrap()`.

## macOS managed mode

Use the same `native.settings` object on macOS and Windows and select `managed` mode. The mode describes ownership: Electron starts and stops the Native SDK on both platforms, even though macOS uses an in-process Node-API addon while Windows uses a managed bridge process. Sampling settings remain in the cross-platform `0..1` range and are converted internally to the macOS Native SDK's `0..100` units.

The shared settings surface includes endpoint settings (`datakitUrl`, or `datawayUrl` with `clientToken`), identity settings (`applicationId`, `service`, `environment`, `version`), RUM settings (`sampleRate`, `actionTrackingEnabled`), Logger settings (`loggingEnabled`, `loggingSampleRate`), Session Replay settings (`replayEnabled`, `replaySampleRate`, `replayPrivacy`), Trace settings (`traceEnabled`, `traceSampleRate`, `traceType`, `traceAllowedUrls`), and runtime settings (`cachePath`, `debug`, `httpTimeoutMs`). In managed mode, `actionTrackingEnabled` maps to the Native SDK's automatic user Action collection; on macOS this is `FTRumConfig.enableTraceUserAction`, which includes Native launch Actions. The setting defaults to `false` when omitted, and no custom launch Action is sent by the adapter. No separate macOS `sdk`, `rum`, `logger`, `trace`, or `sessionReplay` configuration API is required. The current macOS Native binding has no direct setter for `version`, `cachePath`, `traceAllowedUrls`, or `httpTimeoutMs`; those values remain accepted so applications can share one configuration object, while the packaged app supplies its bundle version to the Native SDK.

See [macOS managed settings mapping](docs/macos-managed-settings-mapping.md) for the complete field, conversion, and Native SDK property matrix.

```js
const { bootstrap } = require("@cloudcare/electron-native-adapter");

const client = await bootstrap({
  electron: require("electron"),
  native: {
    mode: "managed",
    directory: macosNativeRuntimeDirectory,
    settings: {
      applicationId: "your-rum-app-id",
      datakitUrl: "http://127.0.0.1:9529",
      service: "desktop-app",
      environment: "production",
      version: "1.0.0",
      actionTrackingEnabled: true,
      loggingEnabled: true,
      replayEnabled: true,
      replayPrivacy: "mask-user-input",
      traceEnabled: true,
    },
  },
  autoAttach: true,
});
```

The runtime directory must contain `guance_electron.node`, `libGuanceElectronNative.dylib`, and the Native SDK resource bundle produced by the matching `ft-sdk-ios-macos-sessionreplay` release. Keep these files together and outside ASAR when packaging the Electron application. A manually attached macOS target must be a `BrowserWindow`, or a `WebContents` that Electron can resolve back to its host `BrowserWindow`, because Native registration requires `getNativeWindowHandle()`.

### Build the macOS runtime

The Electron-specific Native source is stored in `native/darwin`. It builds against the `GuanceElectronWebView` SwiftPM product from `https://github.com/GuanceCloud/datakit-ios.git`, pinned to the exact `1.6.8-alpha.1` tag.

```sh
npm run build:native:macos:universal
npm run verify:native:macos
```

The build writes `guance_electron.node`, `libGuanceElectronNative.dylib`, and the SDK resource bundle to `native/darwin/runtime`. That directory is ignored by Git and excluded from the npm tarball. `build:native:macos` builds only the current architecture for faster local iteration; the universal command builds both `arm64` and `x86_64`.

## macOS external mode

In external mode, the Native host initializes the SDK and starts `FTElectronBridgeServer`. It then launches Electron with the socket path, authentication token, and protocol version in these environment variables:

- `GUANCE_ELECTRON_SOCKET_PATH`
- `GUANCE_ELECTRON_AUTH_TOKEN`
- `GUANCE_ELECTRON_PROTOCOL_VERSION`

Electron connects before creating its first `BrowserWindow`; no `native.settings` are passed because the Native host already owns all SDK configuration.

```js
const { app, BrowserWindow } = require("electron");
const { bootstrap } = require("@cloudcare/electron-native-adapter");

let client;

app.whenReady().then(async () => {
  client = await bootstrap({
    electron: require("electron"),
    native: { mode: "external" },
    autoAttach: true,
  });
  const window = new BrowserWindow({ /* include the adapter preload */ });
  client.attachWindow(window);
});

app.once("before-quit", () => {
  void client?.stop();
});
```

For tests or custom launchers, the external Native options also accept explicit `socketPath`, `authenticationToken`, `protocolVersion`, `connectTimeoutMs`, and `environment` values. External mode forwards Browser RUM and Session Replay records. Browser Logger configuration remains owned by the Native host and is not exposed by the current macOS WebView socket protocol.

## Preload integration

Use `@cloudcare/electron-native-adapter/preload/install` when composing an existing preload, or `@cloudcare/electron-native-adapter/preload/standalone` as a sandbox-compatible standalone preload. Both expose only the narrow `FTWebViewJavascriptBridge` API required by Browser RUM; they do not expose arbitrary Electron IPC.

## macOS examples

The repository includes two complete OrbitDesk applications under `examples/macos`. Both retain a multi-page UI with actions, requests, errors, Session Replay, and multiple BrowserWindows:

- `examples/macos/electron`: a pure Electron application owns the Native SDK through `bootstrap({ native: { mode: "managed", settings } })` and loads the runtime built under `native/darwin/runtime`. Renderer RUM data is forwarded through the Native SDK bridge, while the Apple SDK collects Native lifecycle and launch Actions automatically.
- `examples/macos/native`: a Swift AppKit host owns the Native SDK and `FTElectronBridgeServer`; Electron connects through `bootstrap({ native: { mode: "external" } })`. Its Swift package fetches `datakit-ios` from GitHub at the exact `1.6.8-alpha.1` tag.

```sh
npm run example:macos:install
cp examples/macos/electron/.env.example examples/macos/electron/.env
cp examples/macos/native/.env.example examples/macos/native/.env

# Electron owns the Native SDK.
npm run build:native:macos
npm run example:macos:managed

# The Swift Native host owns the Native SDK.
npm run example:macos:external
```

Use `npm run example:macos:smoke` for an automatic local startup check of both examples. The smoke command uses non-secret local placeholder configuration and exits after each Renderer and adapter are ready. See `examples/macos/README.md` for configuration and prerequisites.

## Local verification

The package intentionally remains `private` at version `0.0.0-local` during the local-validation phase.

```powershell
npm install
npm run check
npm pack --dry-run --json
```

Native EXE, DLL, Node-API addon, and dylib files are intentionally absent from the npm tarball.
