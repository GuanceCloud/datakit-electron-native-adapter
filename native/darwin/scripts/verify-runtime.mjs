import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(root, 'runtime')
const addon = path.join(runtime, 'guance_electron.node')
const dylib = path.join(runtime, 'libGuanceElectronNative.dylib')
const manifestPath = path.join(runtime, 'runtime-manifest.json')

for (const file of [addon, manifestPath]) {
  if (!fs.existsSync(file)) throw new Error(`Native runtime is missing: ${file}`)
}
if (fs.existsSync(dylib)) {
  throw new Error(`Static Native runtime must not contain: ${dylib}`)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (manifest.schemaVersion !== 1 ||
    manifest.mode !== 'managed' ||
    manifest.platform !== 'darwin' ||
    manifest.nativeSDKLinkage !== 'static') {
  throw new Error(`Invalid Native runtime manifest: ${manifestPath}`)
}
if (!Array.isArray(manifest.architectures) || manifest.architectures.length === 0) {
  throw new Error('Native runtime manifest has no architectures')
}
execFileSync('/usr/bin/lipo', [addon, '-verify_arch', ...manifest.architectures])
execFileSync('/usr/bin/codesign', ['--verify', '--verbose=2', addon], {
  stdio: ['ignore', 'ignore', 'pipe'],
})

const bundles = fs.readdirSync(runtime, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('.bundle'))
if (bundles.length === 0) {
  throw new Error(`Native runtime has no resource bundle: ${runtime}`)
}
const addonDependencies = execFileSync('/usr/bin/otool', ['-L', addon], {
  encoding: 'utf8',
})
if (addonDependencies.includes('libGuanceElectronNative')) {
  throw new Error('Node-API addon still dynamically links GuanceElectronNative')
}

const objectiveCMetadata = execFileSync('/usr/bin/nm', ['-m', addon], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
})
for (const category of [
  '__OBJC_$_CATEGORY_NSApplication_$_FTAutotrack',
  '__OBJC_$_CATEGORY_NSWindow_$_FTAutoTrack',
  '__OBJC_$_CATEGORY_WKWebView_$_FTAutoTrack',
]) {
  if (!objectiveCMetadata.includes(category)) {
    throw new Error(`Static Node-API addon is missing Objective-C Category: ${category}`)
  }
}

const strings = execFileSync('/usr/bin/strings', [addon], { encoding: 'utf8' })
if (/\/Users\/|native\/darwin\/\.build/u.test(strings)) {
  throw new Error('Node-API addon contains an absolute developer build path')
}
const loadCommands = execFileSync('/usr/bin/otool', ['-l', addon], {
  encoding: 'utf8',
})
if (/path \/Applications\/Xcode|path \/Library\/Developer|swift-runtime/u.test(loadCommands)) {
  throw new Error('Node-API addon contains a developer-toolchain rpath')
}

const require = createRequire(import.meta.url)
const binding = require(addon)
for (const method of [
  'invoke',
  'getElectronBridgeConfiguration',
  'registerElectronWebContents',
  'updateElectronWebContents',
  'receiveElectronWebContentsMessage',
  'unregisterElectronWebContents',
  'setElectronCommandHandler',
]) {
  if (typeof binding[method] !== 'function') {
    throw new Error(`Node-API addon is missing ${method}()`)
  }
}

console.log(
  `Verified ${manifest.architectures.join(' + ')} macOS managed runtime in ${runtime}`,
)
