# Windows x64 Electron runtime

Installed automatically as an optional dependency of `@cloudcare/electron-native-adapter`.
Contains the Release Bridge EXE, Native DLL, and their source and SHA-256 manifest.
C++ source and builds belong to the Windows SDK repository.

Requires the Microsoft Visual C++ v14 x64 Redistributable and Windows Universal CRT.
No install script, compilation, vcpkg, or download runs in the consumer.
See `runtime/runtime-manifest.json` for SDK revision, CRT imports and signature status.
