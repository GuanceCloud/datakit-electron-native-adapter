#!/usr/bin/env node

import { formatCLIError, runCustomerCLI } from '../native/darwin/scripts/lib/customer-cli.mjs'

try {
  runCustomerCLI({ argv: process.argv.slice(2) })
} catch (error) {
  console.error(`ft-electron-native: ${formatCLIError(error)}`)
  process.exitCode = 1
}
