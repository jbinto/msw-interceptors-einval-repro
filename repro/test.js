#!/usr/bin/env node
const http = require('http')
const fs = require('fs')
const { execSync } = require('child_process')
const nock = require('nock')
const chalk = require('chalk')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')

// ANSI colors for logging
const C = {
  RESET: '\x1b[0m',
  CYAN: '\x1b[36m',
  YELLOW: '\x1b[33m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  BLUE: '\x1b[34m',
  GRAY: '\x1b[90m',
}

// Parse CLI arguments
const argv = yargs(hideBin(process.argv))
  .usage(
    'Usage: $0 [options]\n\nNote: Use MSW_USE_FIX env var to control fix behavior'
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
  .help('h')
  .alias('h', 'help')
  .example('pnpm test:baseline', 'Run baseline test (should FAIL with EINVAL)')
  .example('pnpm test:fix', 'Run with fix enabled (should PASS)')
  .epilogue('For more information, see README.md').argv

// Run a single test
async function runSingleTest(concurrency, requests) {
  return new Promise((resolve) => {
    // Configure nock (activates @mswjs/interceptors)
    nock.enableNetConnect()
    nock('https://non-existent-domain.com').get('/').reply(200)

    // Track EINVAL errors and HANDLE MISMATCH warnings
    let hasEinval = false
    let hasHandleMismatch = false
    const originalStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (...args) => {
      const msg = String(args[0])
      if (msg.includes('EINVAL')) {
        hasEinval = true
      }
      if (msg.includes('HANDLE MISMATCH')) {
        hasHandleMismatch = true
      }
      return originalStderrWrite(...args)
    }

    const server = http.createServer((req, res) => {
      res.writeHead(200)
      res.end('ok')
    })

    // Track all connections to force-close them
    const connections = new Set()
    server.on('connection', (conn) => {
      connections.add(conn)
      conn.on('close', () => {
        connections.delete(conn)
      })
    })

    // Disable keep-alive on server
    server.keepAliveTimeout = 0
    server.headersTimeout = 0

    server.listen(0, () => {
      const port = server.address().port
      let completed = 0
      let started = 0
      const agent = new http.Agent({
        keepAlive: true,
        maxSockets: concurrency,
      })

      function makeRequest() {
        if (started >= requests) return
        started++

        const req = http.request(
          {
            port,
            method: 'POST',
            path: '/',
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
                console.log(
                  `\n[test.js] 🎯 done completed=${C.BLUE}${completed}${C.RESET}/${C.BLUE}${requests}${C.RESET}`
                )
                console.log(
                  `[test.js] 🧹 cleanup agent=${C.YELLOW}destroy${C.RESET} conns=${C.BLUE}${connections.size}${C.RESET}`
                )
                agent.destroy()
                connections.forEach((conn) => conn.destroy())
                console.log(
                  `[test.js] 🔌 closed conns=${C.BLUE}${connections.size}${C.RESET}`
                )
                console.log('[test.js] 🚪 server.close()')
                server.close(() => {
                  console.log('[test.js] ✅ server closed')
                  process.stderr.write = originalStderrWrite
                  console.log('[test.js] 📤 resolve')
                  resolve({ hasEinval, hasHandleMismatch, completed })
                })
              } else {
                makeRequest()
              }
            })
          }
        )

        req.on('error', (err) => {
          completed++
          if (completed >= requests) {
            console.log(
              `\n[test.js] 💥 error completed=${C.BLUE}${completed}${C.RESET}/${C.BLUE}${requests}${C.RESET} err=${C.RED}${err.code}${C.RESET}`
            )
            console.log(
              `[test.js] 🧹 cleanup agent=${C.YELLOW}destroy${C.RESET} conns=${C.BLUE}${connections.size}${C.RESET}`
            )
            agent.destroy()
            connections.forEach((conn) => conn.destroy())
            console.log(
              `[test.js] 🔌 closed conns=${C.BLUE}${connections.size}${C.RESET}`
            )
            console.log('[test.js] 🚪 server.close()')
            server.close(() => {
              console.log('[test.js] ✅ server closed')
              process.stderr.write = originalStderrWrite
              console.log('[test.js] 📤 resolve')
              resolve({ hasEinval, hasHandleMismatch, completed })
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
  const typeAEnabled = process.env.MSW_USE_FIX === 'true'

  console.log(
    `[test.js] 🧪 test fix=${
      typeAEnabled ? C.GREEN + 'true' : C.RED + 'false'
    }${C.RESET} conc=${C.BLUE}${concurrency}${C.RESET} reqs=${
      C.BLUE
    }${requests}${C.RESET}`
  )

  const result = await runSingleTest(concurrency, requests)

  if (result.hasHandleMismatch) {
    console.log(
      `[test.js] ⚠️  warning handleMismatch=${C.YELLOW}detected${C.RESET}`
    )
  } else {
    console.log(
      `[test.js] ✅ handleMismatch=${C.GREEN}none${C.RESET} ${C.GRAY}(_handle aliasing fixed or non-happy-eyeballs env)${C.RESET}`
    )
  }

  if (result.hasHandleMismatch && result.hasEinval) {
    console.log(
      `[test.js] ${C.RED}⚠️  Both EINVAL and HANDLE MISMATCH detected${C.RESET}`
    )
    console.log(
      `[test.js] ${C.RED}   → Baseline behavior: happy eyeballs + socket confusion + errors expected${C.RESET}`
    )
  } else if (result.hasHandleMismatch && !result.hasEinval) {
    console.log(
      `[test.js] ${C.YELLOW}⚠️  No EINVALs detected, but HANDLE MISMATCH was detected${C.RESET}`
    )
    console.log(
      `[test.js] ${C.YELLOW}   → You are in a happy eyeballs environment with socket confusion${C.RESET}`
    )
    console.log(
      `[test.js] ${C.YELLOW}   → EINVAL crashes fixed, but underlying problem not solved${C.RESET}`
    )
  } else if (!result.hasHandleMismatch && !result.hasEinval) {
    console.log(
      `[test.js] ${C.GREEN}✅ No EINVAL and no HANDLE MISMATCH${C.RESET}`
    )
    console.log(
      `[test.js] ${C.GREEN}   → Either not in happy eyeballs environment OR socket confusion completely fixed${C.RESET}`
    )
  }

  if (result.hasEinval) {
    console.log(`[test.js] ❌ fail einval=${C.RED}detected${C.RESET}`)
    return false
  } else {
    console.log(`[test.js] ✅ pass einval=${C.GREEN}none${C.RESET}`)
    return true
  }
}

// Main execution
async function main() {
  try {
    await executeSingleTest(argv.concurrency, argv.requests)
  } finally {
    process.exit(0)
  }
}

main().catch((err) => {
  console.error(chalk.red('Error:'), err)
  process.exit(1)
})
