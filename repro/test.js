#!/usr/bin/env node
const https = require('https')
const http = require('http')
const fs = require('fs')
const { execSync } = require('child_process')
const nock = require('nock')
const chalk = require('chalk')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')

// Parse CLI arguments
const argv = yargs(hideBin(process.argv))
  .usage(
    'Usage: $0 [options]\n\nNote: Use MSW_MODIFIED_BEHAVIOR_TYPE_A env var to control fix behavior'
  )
  .option('concurrency', {
    alias: 'c',
    type: 'number',
    default: 300,
    description: 'Number of concurrent requests',
  })
  .option('requests', {
    alias: 'r',
    type: 'number',
    default: 2000,
    description: 'Total number of requests',
  })
  .option('matrix', {
    alias: 'm',
    type: 'boolean',
    default: false,
    description: 'Run full test matrix',
  })
  .help('h')
  .alias('h', 'help')
  .example('pnpm test:baseline', 'Run baseline test (should FAIL with EINVAL)')
  .example('pnpm test:fix', 'Run with fix enabled (should PASS)')
  .example('pnpm test:matrix:baseline', 'Run full test matrix without fix')
  .example('pnpm test:matrix:fix', 'Run full test matrix with fix')
  .epilogue('For more information, see README.md').argv

// Mock Datadog server
let mockServer = null

function startMockServer() {
  return new Promise((resolve) => {
    const handler = (req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
        })
        res.end('{}')
      })
      req.on('error', () => {})
    }

    mockServer = http.createServer(handler)
    mockServer.listen(8126, () => {
      resolve()
    })
  })
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve())
    } else {
      resolve()
    }
  })
}

// Generate self-signed certs if needed
function ensureCertificates() {
  if (!fs.existsSync('server.key') || !fs.existsSync('server.cert')) {
    try {
      execSync(
        'openssl req -nodes -new -x509 -keyout server.key -out server.cert -days 365 -subj "/CN=localhost"',
        { stdio: 'ignore' }
      )
    } catch (e) {
      console.error(
        chalk.red('❌ Failed to generate certificates. Please install openssl.')
      )
      process.exit(1)
    }
  }
}

// Set dd-trace environment before requiring it
process.env.DD_TEST_SESSION_NAME = 'repro-session'
process.env.DD_TRACE_AGENT_URL = 'http://localhost:8126'
process.env.DD_API_KEY = 'mock-key'
process.env.DD_SITE = 'localhost'

// Load dd-trace once at startup
require('dd-trace/ci/init')

// Run a single test
async function runSingleTest(concurrency, requests) {
  return new Promise((resolve) => {
    // Configure nock (activates @mswjs/interceptors)
    nock.enableNetConnect()
    nock('https://non-existent-domain.com').get('/').reply(200)

    const httpsOptions = {
      key: fs.readFileSync('server.key'),
      cert: fs.readFileSync('server.cert'),
    }

    // Track EINVAL errors
    let hasEinval = false
    const originalStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (...args) => {
      const msg = String(args[0])
      if (msg.includes('EINVAL')) {
        hasEinval = true
      }
      return originalStderrWrite(...args)
    }

    const server = https.createServer(httpsOptions, (req, res) => {
      res.writeHead(200)
      res.end('ok')
    })

    server.listen(0, () => {
      const port = server.address().port
      let completed = 0
      let started = 0
      const agent = new https.Agent({
        keepAlive: true,
        maxSockets: concurrency,
      })

      function makeRequest() {
        if (started >= requests) return
        started++

        const req = https.request(
          {
            port,
            method: 'POST',
            path: '/',
            rejectUnauthorized: false,
            headers: { connection: 'keep-alive' },
            agent,
          },
          (res) => {
            res.resume()
            res.on('end', () => {
              completed++
              if (completed % 500 === 0) {
                process.stdout.write('.')
              }
              if (completed >= requests) {
                server.close(() => {
                  process.stderr.write = originalStderrWrite
                  resolve({ hasEinval, completed })
                })
              } else {
                makeRequest()
              }
            })
          }
        )

        req.on('error', () => {
          completed++
          if (completed >= requests) {
            server.close(() => {
              process.stderr.write = originalStderrWrite
              resolve({ hasEinval, completed })
            })
          } else {
            makeRequest()
          }
        })

        req.write('test data')
        req.end()
      }

      // Start concurrent requests
      for (let i = 0; i < concurrency; i++) {
        makeRequest()
      }
    })
  })
}

// Run single test with display
async function executeSingleTest(concurrency, requests) {
  const typeAEnabled = process.env.MSW_MODIFIED_BEHAVIOR_TYPE_A === 'true'

  console.log(chalk.bold('\n🧪 Running Test'))
  console.log(chalk.gray('─────────────────'))
  console.log(
    chalk.cyan(`TYPE_A: ${typeAEnabled ? 'ENABLED ✓' : 'DISABLED ✗'}`)
  )
  console.log(chalk.cyan(`Concurrency: ${concurrency}`))
  console.log(chalk.cyan(`Requests: ${requests}`))
  console.log(
    chalk.gray(
      `Env: MSW_MODIFIED_BEHAVIOR_TYPE_A=${
        process.env.MSW_MODIFIED_BEHAVIOR_TYPE_A || 'unset'
      }`
    )
  )
  console.log()

  const result = await runSingleTest(concurrency, requests)

  console.log()
  if (result.hasEinval) {
    console.log(chalk.red('❌ FAIL - EINVAL errors detected'))
    return false
  } else {
    console.log(chalk.green('✅ PASS - No EINVAL errors'))
    return true
  }
}

// Run test matrix
async function runMatrix() {
  const concurrencies = [100, 200, 300, 500]
  const typeAEnabled = process.env.MSW_MODIFIED_BEHAVIOR_TYPE_A === 'true'
  const mode = typeAEnabled ? 'TYPE_A' : 'Baseline'
  const results = []

  console.log(chalk.bold(`\n🎯 Running Test Matrix (${mode} mode)`))
  console.log(chalk.gray('═══════════════════════════════════════════════'))
  console.log(
    chalk.gray(
      `MSW_MODIFIED_BEHAVIOR_TYPE_A=${
        process.env.MSW_MODIFIED_BEHAVIOR_TYPE_A || 'unset'
      }`
    )
  )
  console.log()

  for (const concurrency of concurrencies) {
    console.log(chalk.bold(`\n📊 Testing at ${concurrency} concurrency`))
    console.log(chalk.gray('─────────────────'))
    const result = await runSingleTest(concurrency, 2000)
    console.log()

    const status = result.hasEinval
      ? chalk.red('FAIL ❌')
      : chalk.green('PASS ✅')
    console.log(`Result: ${status}`)

    results.push({
      concurrency,
      hasEinval: result.hasEinval,
    })
  } // Print summary table
  console.log(chalk.bold('\n\n📋 Test Matrix Summary'))
  console.log(chalk.gray('═══════════════════════════════════════════════'))
  console.log()
  console.log(`  Concurrency │ ${mode}  `)
  console.log('  ────────────┼─────────')

  for (const result of results) {
    const display = result.hasEinval
      ? chalk.red('FAIL ❌')
      : chalk.green('PASS ✅')
    console.log(`  ${String(result.concurrency).padEnd(11)} │ ${display}`)
  }
  console.log()

  // Overall assessment
  const failed = results.filter((r) => r.hasEinval).length

  if (failed === 0) {
    console.log(chalk.green.bold(`✅ All tests PASSED in ${mode} mode`))
  } else if (failed === results.length) {
    console.log(chalk.red.bold(`❌ All tests FAILED in ${mode} mode`))
  } else {
    console.log(
      chalk.yellow.bold(
        `⚠️  Mixed results: ${failed}/${results.length} failed in ${mode} mode`
      )
    )
  }
  console.log()
} // Main execution
async function main() {
  ensureCertificates()
  await startMockServer()

  try {
    if (argv.matrix) {
      await runMatrix()
    } else {
      await executeSingleTest(argv.concurrency, argv.requests)
    }
  } finally {
    await stopMockServer()
    process.exit(0)
  }
}

main().catch((err) => {
  console.error(chalk.red('Error:'), err)
  stopMockServer().then(() => process.exit(1))
})
