# Changelog

## 0.1.0-alpha.1

First alpha release of `@cloudcare/electron-native-adapter`.

### Added

- Connect Electron Renderer Browser RUM, Logs, and Session Replay events to the Windows and macOS Native SDKs.
- Provide a shared `bootstrap()` API with managed Full Mode and application-owned external Mixed Mode, window lifecycle management, capability negotiation, and graceful shutdown.
- Download Windows x64 and macOS Universal runtimes by default during npm installation from their own Native SDK GitHub Releases. A supplied offline archive takes precedence, with the same SHA-256 and manifest validation. Skipping installation requires an explicit opt-out.
- Provide `stageWindowsRuntime()` to copy the complete Windows runtime outside ASAR when packaging an Electron application.
- Provide `guance-electron-native --sdk-version` for remote installation and `--runtime-archive` for offline installation. Native builds remain in the SDK repositories.
- Provide `stageMacOSRuntime()` to stage the downloaded addon and resource bundles outside ASAR.
- Provide sandbox-compatible preload entry points and automatic cold and hot launch tracking.

### Compatibility

- Windows Electron compatibility baselines: `22.3.27` and `43.x`. Intermediate Electron major versions have not been validated.
- Downloaded Windows binaries support x64 and require the Microsoft Visual C++ v14 x64 Redistributable and Windows Universal CRT.
- macOS managed mode uses a downloaded Universal runtime; application-owned source builds remain supported via an explicit directory. Neither platform's native binaries are bundled in npm.
- Linux is not supported. This alpha release is intended for integration testing.
- npm installation and the runtime installer require Node.js 18+; the adapter runtime retains its Electron 22/Node.js 16.17.1 baseline. Windows remote asset naming and live native acceptance remain pending.
