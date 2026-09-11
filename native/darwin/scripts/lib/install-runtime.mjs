import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extract } from 'tar'
import windowsRuntime from '../../../../platform/win32/runtime.cjs'

export const DEFAULT_DOWNLOAD_BASE_URL = 'https://github.com/GuanceCloud/datakit-ios/releases/download'
export const WINDOWS_DOWNLOAD_BASE_URL = 'https://github.com/GuanceCloud/datakit-windows-desktop/releases/download'
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

export function runtimeRelease({ sdkVersion, target = 'darwin-universal', assetName,
  downloadBaseURL = target === 'win32-x64' ? WINDOWS_DOWNLOAD_BASE_URL : DEFAULT_DOWNLOAD_BASE_URL } = {}) {
  if (!['darwin-universal', 'win32-x64'].includes(target)) throw new Error('Unsupported runtime target: ' + target)
  if (!sdkVersion) throw new Error('Native SDK version is required')
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(sdkVersion)) {
    throw new Error('Invalid Native SDK version: ' + sdkVersion)
  }
  const base = new URL(downloadBaseURL)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Runtime download base must be an HTTPS URL without credentials, query, or fragment')
  }
  const version = sdkVersion.replace(/^v/u, '')
  if (target === 'win32-x64' && !assetName) throw new Error('Windows remote installation requires --asset-name with the exact SDK Release .tar.gz filename')
  const filename = assetName || 'guance-electron-runtime-' + version + '-darwin-universal.tar.gz'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/u.test(filename)) throw new Error('Asset name must be a .tar.gz filename without a directory')
  return {
    version, filename, target,
    url: base.href.replace(/\/$/u, '') + '/' + encodeURIComponent(sdkVersion) + '/' + filename,
  }
}

function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function verifyArchive(archive, checksumFile = archive + '.sha256') {
  if (!fs.statSync(archive).isFile() || fs.statSync(archive).size > MAX_ARCHIVE_BYTES) {
    throw new Error('Runtime archive is not a regular file or exceeds the size limit')
  }
  if (fs.statSync(checksumFile).size > 4096) throw new Error('Invalid runtime checksum file')
  const checksum = fs.readFileSync(checksumFile, 'utf8').trim().match(/^([a-f0-9]{64})(?:[ \t]+\*?[^\r\n]+)?$/iu)?.[1]
  if (!checksum || fileHash(archive) !== checksum.toLowerCase()) {
    throw new Error('Runtime archive SHA-256 mismatch: ' + path.basename(archive))
  }
}

function runtimeFiles(directory, relative = '') {
  const files = {}
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name
    if (entry.isDirectory()) Object.assign(files, runtimeFiles(directory, name))
    else if (entry.isFile()) {
      if (name !== 'runtime-manifest.json') files[name] = fileHash(path.join(directory, name))
    } else throw new Error('Runtime contains a link or special file: ' + name)
  }
  return files
}

export function validateRuntime(directory, release) {
  if (release.target === 'win32-x64') {
    const entries = fs.readdirSync(directory)
    if (entries.some((name) => !['guance_windows_electron_bridge.exe', 'guance_windows_native.dll', 'runtime-manifest.json', 'LICENSE'].includes(name))) throw new Error('Unexpected Windows runtime file')
    runtimeFiles(directory)
    const manifest = windowsRuntime.validateRuntime(directory)
    if (manifest.sdkVersion !== release.version) throw new Error('Windows runtime SDK version does not match the requested version')
    return manifest
  }
  const files = runtimeFiles(directory)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'runtime-manifest.json'), 'utf8'))
  const architectures = ['arm64', 'x86_64']
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'managed' ||
      manifest.platform !== 'darwin' || manifest.nativeSDKLinkage !== 'static' ||
      manifest.configuration !== 'release' || manifest.nativeSDK?.version !== release.version ||
      manifest.nodeAPIVersion !== 8 || !/^\d+\.\d+(?:\.\d+)?$/u.test(manifest.minimumMacOSVersion || '') ||
      !Array.isArray(manifest.architectures) ||
      JSON.stringify([...manifest.architectures].sort()) !== JSON.stringify(architectures.sort())) {
    throw new Error('Runtime manifest does not match the requested SDK version or Universal format')
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  if (!files['guance_electron.node'] || !entries.some((entry) => entry.isDirectory() && entry.name.endsWith('.bundle')) ||
      entries.some((entry) => !(entry.isDirectory() && entry.name.endsWith('.bundle')) &&
        !['guance_electron.node', 'runtime-manifest.json'].includes(entry.name))) {
    throw new Error('Runtime must contain the addon, resource bundles, and manifest only')
  }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) ||
      Object.keys(files).length !== Object.keys(manifest.files).length ||
      Object.entries(files).some(([name, hash]) => manifest.files[name] !== hash)) {
    throw new Error('Runtime file checksums do not match the manifest')
  }
  return manifest
}

async function download(url, destination, limit, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) {
    throw new Error('Unable to download published runtime (HTTP ' + response.status + '): ' + url)
  }
  if (response.url && new URL(response.url).protocol !== 'https:') {
    throw new Error('Runtime download redirected to a non-HTTPS URL')
  }
  let bytes = 0
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length
      callback(bytes > limit ? new Error('Runtime download exceeds the size limit') : null, chunk)
    },
  }), fs.createWriteStream(destination, { flags: 'wx' }))
}

async function unpack(archive, destination, target) {
  let invalidEntry
  let bytes = 0
  await extract({
    file: archive, cwd: destination, strict: true, preservePaths: false, noMtime: true,
    filter(name, entry) {
      const parts = name.replace(/\/$/u, '').split('/')
      bytes += entry.size || 0
      if (!['File', 'Directory'].includes(entry.type) || (target !== 'win32-x64' && parts[0] !== 'runtime') ||
          parts.some((part) => !part || part === '.' || part === '..') ||
          name.includes('\\') || name.includes(':') || name.includes('\0') || bytes > MAX_ARCHIVE_BYTES) {
        invalidEntry = name
        return false
      }
      return true
    },
  })
  if (invalidEntry !== undefined) throw new Error('Invalid runtime archive entry: ' + invalidEntry)
}

export async function installManagedRuntime({ applicationRoot, options = {}, fetchImpl = globalThis.fetch }) {
  // A local SDK archive has no network naming dependency; its manifest is authoritative.
  const release = runtimeRelease({ ...options, assetName: options.assetName || (options.target === 'win32-x64' && options.runtimeArchive ? 'local-runtime.tar.gz' : undefined) })
  const buildRoot = path.resolve(applicationRoot, '.cloudcare', 'native', release.target === 'win32-x64' ? 'win32-x64' : 'darwin')
  const output = path.join(buildRoot, 'runtime')
  fs.mkdirSync(buildRoot, { recursive: true })
  const lock = path.join(buildRoot, '.install-lock')
  try { fs.mkdirSync(lock) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error('Another runtime installation is active; if it was interrupted, remove ' + lock)
  }
  let stage
  try {
    stage = fs.mkdtempSync(path.join(buildRoot, '.install-'))
    let cacheDestination
    let archive = options.runtimeArchive && path.resolve(options.runtimeArchive)
    if (archive) {
      verifyArchive(archive)
    } else {
      const cache = path.join(buildRoot, '.cache')
      fs.mkdirSync(cache, { recursive: true })
      const identity = createHash('sha256').update(release.url).digest('hex').slice(0, 16)
      archive = path.join(cache, identity + '-' + release.filename)
      let cached = false
      try { verifyArchive(archive); cached = true } catch {}
      if (!cached) {
        const downloaded = path.join(stage, release.filename)
        await download(release.url + '.sha256', downloaded + '.sha256', 4096, fetchImpl)
        await download(release.url, downloaded, MAX_ARCHIVE_BYTES, fetchImpl)
        verifyArchive(downloaded)
        cacheDestination = archive
        archive = downloaded
      }
    }
    const unpacked = path.join(stage, 'unpacked')
    fs.mkdirSync(unpacked)
    await unpack(archive, unpacked, release.target)
    const nested = path.join(unpacked, 'runtime')
    const runtime = release.target === 'win32-x64' && !fs.existsSync(nested) ? unpacked : nested
    if (runtime === nested && fs.readdirSync(unpacked).some((name) => name !== 'runtime')) throw new Error('Unexpected files outside runtime directory')
    validateRuntime(runtime, release)
    if (cacheDestination) {
      fs.copyFileSync(archive, cacheDestination)
      fs.copyFileSync(archive + '.sha256', cacheDestination + '.sha256')
    }
    const previous = path.join(stage, 'previous')
    if (fs.existsSync(output)) fs.renameSync(output, previous)
    try { fs.renameSync(runtime, output) } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, output)
      throw error
    }
    return output
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(lock, { recursive: true, force: true })
  }
}
