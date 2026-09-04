# OrbitDesk — Native-owned external mode

This example keeps the AppKit Native Host and Electron business surfaces as separate processes. The Swift host owns SDK configuration and starts `FTElectronBridgeServer`; the Electron Main process connects with `native.mode: "external"` before creating its first BrowserWindow.

The Swift package uses the GitHub dependency below and does not depend on a local checkout:

```swift
.package(
    url: "https://github.com/GuanceCloud/datakit-ios.git",
    exact: "1.6.8-alpha.1"
)
```

From the repository root:

```sh
npm run example:macos:install
cp examples/macos/native/.env.example examples/macos/native/.env
npm run example:macos:external
```

The development command builds the Swift host and an accessory Electron app, starts Vite, and launches the Native-owned application. Browser RUM uses bridge-only defaults and forwards Renderer events to the Native SDK. Native SDK options, including `GUANCE_NATIVE_ACTION_TRACKING`, remain in the Swift host; no `native.settings` object is passed to Electron.
