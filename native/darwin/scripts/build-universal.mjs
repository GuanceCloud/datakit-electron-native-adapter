import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManagedRuntime, parseBuildArguments } from './lib/build-runtime.mjs'

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = parseBuildArguments(process.argv.slice(2))
const output = buildManagedRuntime({ adapterRoot, options, universal: true })
console.log(`Built the universal macOS managed runtime in ${output}`)
