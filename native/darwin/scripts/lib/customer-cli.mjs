import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManagedRuntime, parseBuildArguments } from './build-runtime.mjs'

export const CLI_USAGE = `Usage:
  ft-electron-native managed [options]

Builds the macOS Native runtime owned by Electron. Universal output is the default.

Options:
  --arch <universal|current|arm64|x64>  Target architecture (default: universal)
  --debug                              Build the Native SDK in debug mode
  --sdk-root <path>                    Use a local Native SDK checkout for development
  --sdk-ref <ref>                      Override the fixed Native SDK ref
  --sdk-repository <url>               Override the Native SDK repository
  -h, --help                           Show this help
`

const PUBLIC_ARCHITECTURES = new Set(['universal', 'current', 'arm64', 'x64'])

class CLIUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CLIUsageError'
  }
}

function architectureValue(argument, nextArgument) {
  if (argument === '--arch') {
    if (!nextArgument || nextArgument.startsWith('-')) {
      throw new CLIUsageError('--arch requires a value')
    }
    return { consumed: 1, value: nextArgument }
  }
  const assignment = argument.match(/^--arch=(.+)$/u)
  return assignment ? { consumed: 0, value: assignment[1] } : undefined
}

export function parseCustomerCLIArguments(argv, environment = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }

  const command = argv[0]
  if (!command) throw new CLIUsageError('A mode is required')
  if (command === 'external') {
    throw new CLIUsageError(
      'External mode uses the Native host SDK and does not build an npm-managed runtime',
    )
  }
  if (command !== 'managed') throw new CLIUsageError(`Unknown mode: ${command}`)

  let architecture = 'universal'
  let architectureWasSet = false
  const buildArguments = []
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    const parsedArchitecture = architectureValue(argument, argv[index + 1])
    if (parsedArchitecture) {
      if (architectureWasSet) throw new CLIUsageError('--arch may only be specified once')
      architecture = parsedArchitecture.value
      architectureWasSet = true
      index += parsedArchitecture.consumed
      continue
    }
    buildArguments.push(argument)
  }
  if (!PUBLIC_ARCHITECTURES.has(architecture)) {
    throw new CLIUsageError(`Unsupported architecture: ${architecture}`)
  }

  return {
    architecture,
    buildOptions: parseBuildArguments(buildArguments, environment),
    help: false,
  }
}

export function customerManagedPaths(applicationRoot) {
  const root = path.resolve(applicationRoot)
  const buildRoot = path.join(root, '.cloudcare', 'native', 'darwin')
  return Object.freeze({
    applicationRoot: root,
    buildRoot,
    output: path.join(buildRoot, 'runtime'),
  })
}

export function managedArchitectureSelection(architecture) {
  if (architecture === 'universal') return Object.freeze({ universal: true })
  if (architecture === 'current') return Object.freeze({ universal: false })
  if (architecture === 'arm64') {
    return Object.freeze({ architecture: 'arm64', universal: false })
  }
  if (architecture === 'x64') {
    return Object.freeze({ architecture: 'x86_64', universal: false })
  }
  throw new CLIUsageError(`Unsupported architecture: ${architecture}`)
}

export function runCustomerCLI({
  argv,
  build = buildManagedRuntime,
  cwd = process.cwd(),
  environment = process.env,
  write = console.log,
} = {}) {
  const parsed = parseCustomerCLIArguments(argv || [], environment)
  if (parsed.help) {
    write(CLI_USAGE.trimEnd())
    return { help: true }
  }

  const darwinRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  )
  const paths = customerManagedPaths(cwd)
  const selection = managedArchitectureSelection(parsed.architecture)
  const output = build({
    adapterRoot: darwinRoot,
    buildRoot: paths.buildRoot,
    options: parsed.buildOptions,
    output: paths.output,
    ...selection,
  })
  write(`Built the ${parsed.architecture} macOS managed runtime in ${output}`)
  return { architecture: parsed.architecture, output }
}

export function formatCLIError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof CLIUsageError ? `${message}\n\n${CLI_USAGE.trimEnd()}` : message
}
