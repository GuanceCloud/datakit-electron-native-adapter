import path from 'node:path'
import { installManagedRuntime, runtimeRelease } from './install-runtime.mjs'

export const CLI_USAGE = [
  'Usage: guance-electron-native --sdk-version <version> [options]',
  '',
  'Installs the precompiled SDK runtime (Universal macOS or Windows x64) for full (managed) mode, remotely or offline.',
  'Mixed (external) mode uses the Native host SDK and must not install this runtime.',
  '',
  'Options:',
  '  --sdk-version <version>              Native SDK release version (required)',
  '  --download-base-url <https-url>       Override the release download base (mirror)',
  '  --runtime-archive <path>              Install a local archive with its .sha256 sidecar',
  '  --target <darwin-universal|win32-x64>  Override the current platform',
  '  --asset-name <filename.tar.gz>        Exact Release filename (required for Windows remote installs)',
  '  -h, --help                            Show this help',
].join('\n')

class CLIUsageError extends Error {}

export function parseCustomerCLIArguments(argv, environment = process.env, platform = process.platform, arch = process.arch) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  if (argv[0] === 'external') {
    throw new CLIUsageError('External mode uses the Native host SDK and does not install a managed runtime')
  }
  const options = {
    downloadBaseURL: environment.GUANCE_NATIVE_RUNTIME_DOWNLOAD_BASE_URL,
    runtimeArchive: environment.GUANCE_NATIVE_RUNTIME_ARCHIVE,
    target: platform === 'darwin' && ['arm64', 'x64'].includes(arch) ? 'darwin-universal' : platform === 'win32' && arch === 'x64' ? 'win32-x64' : undefined,
  }
  const names = {
    '--sdk-version': 'sdkVersion',
    '--download-base-url': 'downloadBaseURL',
    '--runtime-archive': 'runtimeArchive',
    '--target': 'target',
    '--asset-name': 'assetName',
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const [name, ...assignment] = argv[index].split('=')
    if (!names[name]) throw new CLIUsageError('Unknown argument: ' + name)
    if (seen.has(name)) throw new CLIUsageError(name + ' may only be specified once')
    seen.add(name)
    const value = assignment.length ? assignment.join('=') : argv[++index]
    if (!value || value.startsWith('--')) throw new CLIUsageError(name + ' requires a value')
    options[names[name]] = value
  }
  if (!options.sdkVersion) throw new CLIUsageError('--sdk-version is required')
  if (!options.target) throw new CLIUsageError('Unsupported host; specify a supported --target for cross-platform packaging')
  runtimeRelease({ ...options, assetName: options.assetName || (options.target === 'win32-x64' && options.runtimeArchive ? 'local-runtime.tar.gz' : undefined) })
  return { installOptions: options, help: false }
}

export function customerManagedPaths(applicationRoot) {
  const root = path.resolve(applicationRoot)
  const buildRoot = path.join(root, '.cloudcare', 'native', 'darwin')
  return Object.freeze({ applicationRoot: root, buildRoot, output: path.join(buildRoot, 'runtime') })
}

export async function runCustomerCLI({
  argv = process.argv.slice(2), install = installManagedRuntime, cwd = process.cwd(),
  environment = process.env, write = console.log,
} = {}) {
  const parsed = parseCustomerCLIArguments(argv, environment)
  if (parsed.help) { write(CLI_USAGE); return { help: true } }
  const output = await install({
    applicationRoot: path.resolve(cwd),
    options: parsed.installOptions,
  })
  write('Installed the managed runtime in ' + output)
  return { output }
}

export function formatCLIError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof CLIUsageError ? message + '\n\n' + CLI_USAGE : message
}
