# Changelog

## 0.1.0-alpha.1

First alpha release of `@cloudcare/electron-native-adapter`.

### Added

- Connect Electron Renderer Browser RUM, Logs, and Session Replay events to the Windows and macOS Native SDKs.
- Provide a shared `bootstrap()` API with managed Full Mode and application-owned external Mixed Mode, window lifecycle management, capability negotiation, and graceful shutdown.
- Bundle the Windows x64 Native Bridge EXE and Native SDK DLL in the npm package, with runtime version, architecture, protocol, and SHA-256 validation. Installation requires no native compilation or postinstall download.
- Provide `stageWindowsRuntime()` to copy the complete Windows runtime outside ASAR when packaging an Electron application.
- Provide `ft-electron-native managed` to build a macOS Universal runtime for Apple Silicon and Intel Macs.
- Provide sandbox-compatible preload entry points and automatic cold and hot launch tracking.

### Compatibility

- Windows Electron compatibility baselines: `22.3.27` and `43.x`. Intermediate Electron major versions have not been validated.
- Bundled Windows binaries support x64 and require the Microsoft Visual C++ v14 x64 Redistributable and Windows Universal CRT.
- macOS managed mode requires a separately built native runtime; macOS native binaries are not bundled in this package.
- Linux is not supported. This alpha release is intended for integration testing.
