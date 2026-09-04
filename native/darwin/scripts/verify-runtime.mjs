import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(root, 'runtime')
const addon = path.join(runtime, 'guance_electron.node')
const dylib = path.join(runtime, 'libGuanceElectronNative.dylib')

for (const file of [addon, dylib]) {
  if (!fs.existsSync(file)) throw new Error(`Native runtime is missing: ${file}`)
  execFileSync('/usr/bin/lipo', [file, '-verify_arch', 'arm64', 'x86_64'])
  execFileSync('/usr/bin/codesign', ['--verify', '--verbose=2', file], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

const bundles = fs.readdirSync(runtime, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('.bundle'))
if (bundles.length === 0) {
  throw new Error(`Native runtime has no resource bundle: ${runtime}`)
}
if (fs.existsSync(path.join(runtime, 'swift-runtime'))) {
  throw new Error('Objective-C runtime must not contain a Swift runtime directory')
}

const dylibDependencies = execFileSync('/usr/bin/otool', ['-L', dylib], {
  encoding: 'utf8',
})
if (/libswift/iu.test(dylibDependencies)) {
  throw new Error('Native dylib still links a Swift runtime library')
}
const addonDependencies = execFileSync('/usr/bin/otool', ['-L', addon], {
  encoding: 'utf8',
})
if (!addonDependencies.includes('@rpath/libGuanceElectronNative.dylib')) {
  throw new Error('Node-API addon does not link the adjacent Native bridge dylib')
}

const symbols = execFileSync('/usr/bin/nm', ['-gU', dylib], { encoding: 'utf8' })
if (/(?:\$s|\bswift_)/u.test(symbols)) {
  throw new Error('Native dylib still exports or imports Swift symbols')
}
const strings = execFileSync('/usr/bin/strings', [dylib], { encoding: 'utf8' })
if (/\/Users\/|native\/darwin\/\.build/u.test(strings)) {
  throw new Error('Native dylib contains an absolute developer build path')
}
const loadCommands = execFileSync('/usr/bin/otool', ['-l', dylib], {
  encoding: 'utf8',
})
if (/path \/Applications\/Xcode|path \/Library\/Developer|swift-runtime/u.test(loadCommands)) {
  throw new Error('Native dylib contains a developer-toolchain rpath')
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

console.log(`Verified universal macOS Native runtime in ${runtime}`)
