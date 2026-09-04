import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputs = [path.join(root, '.build'), path.join(root, 'runtime')]

for (const output of outputs) {
  if (path.dirname(output) !== root) {
    throw new Error(`Refusing to clean unexpected output path: ${output}`)
  }
  fs.rmSync(output, { recursive: true, force: true })
}
