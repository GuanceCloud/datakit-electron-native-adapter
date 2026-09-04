# OrbitDesk — Electron-owned managed mode

This is a pure Electron application. Every visible page is rendered by Electron, while the Electron Main process owns and initializes the Guance macOS Native SDK through the Adapter's `managed` mode.

The integration points are:

- `electron/main.cjs`: maps environment variables to the shared `native.settings` object and calls `bootstrap()` with `native.mode: "managed"`.
- `electron/preload.cjs`: installs the Adapter's narrow Browser RUM bridge alongside the example's own IPC API.
- `src/`: initializes Browser RUM with bridge-only defaults, displays the non-sensitive Native settings received from Main, and exercises views, actions, resources, errors, Session Replay, and an auxiliary `BrowserWindow`.

Renderer events are forwarded to the Native SDK through the bridge. Native upload configuration remains owned by `native.settings`; Browser RUM does not need a separate intake endpoint for this transport.

From the repository root:

```sh
npm run example:macos:install
cp examples/macos/electron/.env.example examples/macos/electron/.env
npm run build:native:macos
npm run example:macos:managed
```

`GUANCE_NATIVE_ACTION_TRACKING` maps to `native.settings.actionTrackingEnabled`. When enabled, Native lifecycle and launch Actions remain under the Apple SDK's internal automatic collection; the example does not synthesize them through a custom Action API. Sampling values under `GUANCE_NATIVE_*_SAMPLE_RATE` use the Adapter's cross-platform `0..1` public units.

For a packaged development build:

```sh
npm --prefix examples/macos/electron run package:dir
```

Packaging copies the generated Guance Native runtime to `Contents/Resources/native`. No AppKit UI component or separate Native host is included in this example.
