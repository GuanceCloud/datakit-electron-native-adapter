import path from 'node:path'
import { DEFAULT_NATIVE_SDK_VERSION, DEFAULT_DOWNLOAD_BASE_URL, installManagedRuntime, runtimeRelease } from './install-runtime.mjs'

export const CLI_USAGE = [
  'Usage: ft-electron-native managed [options]',
  '',
  'Downloads and installs the precompiled macOS runtime for full (managed) mode.',
  'Mixed (external) mode uses the Native host SDK and must not install this runtime.',
  '',
  'Options:',
  '  --arch <universal|current|arm64|x64>  Target architecture (default: universal)',
  '  --sdk-version <version>              Override the pinned Native SDK release',
  '  --download-base-url <https-url>       Override the release download base (mirror)',
  '  --runtime-archive <path>              Install a local archive with its .sha256 sidecar',
  '  -h, --help                            Show this help',
].join('\n')

class CLIUsageError extends Error {}

export function parseCustomerCLIArguments(argv, environment = process.env, currentArchitecture = process.arch) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  if (argv[0] === 'external') {
    throw new CLIUsageError('External mode uses the Native host SDK and does not install a managed runtime')
  }
  if (argv[0] !== 'managed') throw new CLIUsageError('Expected the managed command')
  let architecture = 'universal'
  const options = {
    sdkVersion: environment.GUANCE_NATIVE_SDK_VERSION || DEFAULT_NATIVE_SDK_VERSION,
    downloadBaseURL: environment.GUANCE_NATIVE_RUNTIME_DOWNLOAD_BASE_URL || DEFAULT_DOWNLOAD_BASE_URL,
    runtimeArchive: environment.GUANCE_NATIVE_RUNTIME_ARCHIVE,
  }
  const names = {
    '--arch': 'architecture',
    '--sdk-version': 'sdkVersion',
    '--download-base-url': 'downloadBaseURL',
    '--runtime-archive': 'runtimeArchive',
  }
  const seen = new Set()
  for (let index = 1; index < argv.length; index += 1) {
    const [name, ...assignment] = argv[index].split('=')
    if (!names[name]) throw new CLIUsageError('Unknown argument: ' + name)
    if (seen.has(name)) throw new CLIUsageError(name + ' may only be specified once')
    seen.add(name)
    const value = assignment.length ? assignment.join('=') : argv[++index]
    if (!value || value.startsWith('--')) throw new CLIUsageError(name + ' requires a value')
    if (name === '--arch') architecture = value
    else options[names[name]] = value
  }
  if (architecture === 'current') architecture = currentArchitecture
  if (!['universal', 'arm64', 'x64'].includes(architecture)) {
    throw new CLIUsageError('Unsupported architecture: ' + architecture)
  }
  options.architecture = architecture
  runtimeRelease(options)
  return { architecture, installOptions: options, help: false }
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
  write('Installed the ' + parsed.architecture + ' macOS managed runtime in ' + output)
  return { architecture: parsed.architecture, output }
}

export function formatCLIError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof CLIUsageError ? message + '\n\n' + CLI_USAGE : message
}
