#!/usr/bin/env node
import http from 'http'
import nock from 'nock'
import readline from 'readline'
import { networkInterfaces } from 'os'
import dns from 'dns/promises'

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (msg) => console.log(`[test.js] ${msg}`)

function displayDualStackStatus({ ok, hasIPv4, hasIPv6, dnsIPv4, dnsIPv6 }) {
  const mark = (val) => (val ? C.GREEN + '✓' + C.RESET : C.RED + '✗' + C.RESET)
  log(
    `${C.GRAY}dual stack:${C.RESET} ${
      ok
        ? C.GREEN + '✓ complete' + C.RESET
        : C.YELLOW + '⚠ incomplete' + C.RESET
    }`
  )
  log(`  ${mark(hasIPv4)} IPv4 interface`)
  log(`  ${mark(hasIPv6)} IPv6 interface`)
  log(`  ${mark(dnsIPv4)} localhost → IPv4 DNS`)
  log(`  ${mark(dnsIPv6)} localhost → IPv6 DNS`)
}

// Check dual stack support
async function checkDualStack() {
  const ifaces = networkInterfaces()
  const allIfaces = Object.values(ifaces).flat()
  const hasIPv4 = allIfaces.some((i) => i.family === 'IPv4' && !i.internal)
  const hasIPv6 = allIfaces.some(
    (i) => i.family === 'IPv6' && !i.internal && !i.address.startsWith('fe80:')
  )

  let dnsIPv4 = false
  let dnsIPv6 = false
  try {
    const addrs = await dns.lookup('localhost', { all: true })
    dnsIPv4 = addrs.some((a) => a.family === 4)
    dnsIPv6 = addrs.some((a) => a.family === 6)
  } catch {}

  const ok = hasIPv4 && hasIPv6 && dnsIPv4 && dnsIPv6
  const result = { ok, hasIPv4, hasIPv6, dnsIPv4, dnsIPv6 }

  displayDualStackStatus(result)

  if (!ok) {
    log(
      `  ${C.GRAY}→ Without dual stack, Happy Eyeballs won't activate${C.RESET}`
    )
    log(`  ${C.GRAY}→ Race condition likely will not occur${C.RESET}`)
    log(`  ${C.GRAY}→ waiting 7s... CTRL+C to abort${C.RESET}`)
    await wait(7000)
  }

  return result
}

// Read config from env vars
const config = {
  fix: process.env.MSW_USE_FIX === 'true',
  concurrency: parseInt(process.env.CONCURRENCY || '300', 10),
  requests: parseInt(process.env.REQUESTS || '2000', 10),
}

const setupMocks = () => {
  nock.enableNetConnect()
  nock('https://non-existent-domain.com').get('/').reply(200)
}

const trackStderrSignals = () => {
  let hasEinval = false
  let hasHandleMismatch = false
  const original = process.stderr.write.bind(process.stderr)

  process.stderr.write = (...args) => {
    const msg = String(args[0])
    if (msg.includes('EINVAL')) hasEinval = true
    if (msg.includes('HANDLE MISMATCH')) hasHandleMismatch = true
    return original(...args)
  }

  return () => {
    process.stderr.write = original
    return { hasEinval, hasHandleMismatch }
  }
}

const startServer = () => {
  const connections = new Set()
  const server = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })

  server.on('connection', (conn) => {
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
  })

  server.keepAliveTimeout = 0
  server.headersTimeout = 0

  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve({ server, connections, port: server.address().port })
    })
  })
}

const createAgent = (concurrency) =>
  new http.Agent({ keepAlive: true, maxSockets: concurrency })

const issueRequest = ({ port, agent }) =>
  new Promise((resolve, reject) => {
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
        res.on('end', resolve)
      }
    )

    req.on('error', reject)
    req.write('test data')
    req.end()
  })

const shutdown = async ({ server, agent, connections }) => {
  log(
    `🧹 cleanup agent=${C.YELLOW}destroy${C.RESET} conns=${C.BLUE}${connections.size}${C.RESET}`
  )
  agent.destroy()
  connections.forEach((conn) => conn.destroy())
  log(`🔌 closed conns=${C.BLUE}${connections.size}${C.RESET}`)
  await new Promise((resolve) => server.close(resolve))
}

// Run a single test
async function runSingleTest(concurrency, requests) {
  setupMocks()
  const restoreSignals = trackStderrSignals()
  const { server, connections, port } = await startServer()
  const agent = createAgent(concurrency)

  let completed = 0
  let nextRequest = 0
  let lastError = null

  const takeWork = () => (nextRequest < requests ? nextRequest++ : null)

  const markComplete = (err) => {
    if (err) lastError = err
    completed++
  }

  const worker = async () => {
    while (true) {
      if (takeWork() === null) break
      try {
        await issueRequest({ port, agent })
        markComplete()
      } catch (err) {
        markComplete(err)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  const status = lastError
    ? `${C.RED}💥 error${C.RESET} err=${C.RED}${lastError.code}${C.RESET}`
    : `${C.GREEN}🎯 done${C.RESET}`
  log(
    `${status} completed=${C.BLUE}${completed}${C.RESET}/${C.BLUE}${requests}${C.RESET}`
  )

  await shutdown({ server, agent, connections })
  const { hasEinval, hasHandleMismatch } = restoreSignals()
  return { hasEinval, hasHandleMismatch, completed }
}

function reportOutcome({ hasEinval, hasHandleMismatch }) {
  log('')
  if (hasHandleMismatch && hasEinval) {
    log(`   ${C.RED}⚠️  Both EINVAL and HANDLE MISMATCH detected${C.RESET}`)
    log(
      `   ${C.GRAY}→ Fatal error with EINVAL successfully reproduced${C.RESET}`
    )
  } else if (hasHandleMismatch) {
    log(`${C.YELLOW}⚠️  HANDLE MISMATCH detected, but no EINVAL${C.RESET}`)
    log(`   ${C.GRAY}→ Handle mismatch still occurs${C.RESET}`)
    log(`   ${C.GRAY}→ Crashes avoided by the _read fix${C.RESET}`)
  } else {
    log(`${C.GREEN}✅ No HANDLE MISMATCH detected${C.RESET}`)
    log(
      `   ${C.GRAY}→ Either you are not in a dual IPv4/IPv6 environment${C.RESET}`
    )
    log(
      `   ${C.GRAY}→ Or the _handle aliasing bug has been completely fixed 🤞${C.RESET}`
    )
  }

  log('')
  log(
    hasEinval
      ? `${C.RED}❌ TEST FAILED${C.RESET} - EINVAL detected (fatal error)`
      : `${C.GREEN}✅ TEST PASSED${C.RESET} - No EINVAL errors`
  )
}

// Run single test with display
async function executeSingleTest(concurrency, requests) {
  log(
    `🧪 test fix=${config.fix ? C.GREEN + 'true' : C.RED + 'false'}${
      C.RESET
    } conc=${C.BLUE}${concurrency}${C.RESET} reqs=${C.BLUE}${requests}${
      C.RESET
    }`
  )

  const result = await runSingleTest(concurrency, requests)
  reportOutcome(result)
  return !result.hasEinval
}

function printIntro() {
  log(`${C.CYAN}⚡ msw interceptors happy eyeballs stress test${C.RESET}`)
  log(`${C.GRAY}target:${C.RESET} trigger ipv4/ipv6 race`)
  log(
    `${C.GRAY}method:${C.RESET} ${C.BLUE}${config.requests}${C.RESET} reqs × ${C.BLUE}${config.concurrency}${C.RESET} sockets (concurrent)`
  )
  log(
    `${C.GRAY}patched:${C.RESET} ${
      config.fix
        ? `${C.GREEN}yes (MSW_USE_FIX=true)${C.RESET}`
        : `${C.RED}no${C.RESET} (baseline)`
    }`
  )
  log(
    `${C.GRAY}expect:${C.RESET} ${
      config.fix
        ? `${C.GREEN}no einval, no fatal error, ${C.YELLOW}but handle confusion remains${C.RESET}`
        : `${C.RED}einval crash, handle confusion${C.RESET}`
    }`
  )
  log(`${C.GRAY}detect:${C.RESET} einval + handle_mismatch warnings`)
  if (!config.fix) {
    log(
      `${C.GRAY}tip:${C.RESET} to attempt the experimental _read fix, rerun with ${C.YELLOW}MSW_USE_FIX=true${C.RESET}`
    )
  }
  log(`${C.YELLOW}press enter to launch${C.RESET}`)
}

async function promptToLaunch() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  await new Promise((resolve) => rl.question('', () => (rl.close(), resolve())))
}

// Main execution
async function main() {
  const dualStack = await checkDualStack()
  printIntro()
  await promptToLaunch()
  console.log(`${C.GREEN}🚀 LAUNCHING...${C.RESET}\n`)
  await executeSingleTest(config.concurrency, config.requests)

  // Repeat dual stack status for posterity
  log('')
  displayDualStackStatus(dualStack)
  if (!dualStack.ok) {
    log(
      `  ${C.GRAY}→ Without dual stack, Happy Eyeballs won't activate${C.RESET}`
    )
    log(`  ${C.GRAY}→ Race condition likely did not occur${C.RESET}`)
  }

  // Suggest trying with fix if not already enabled
  if (!config.fix) {
    log('')
    log(
      `${C.CYAN}💡 Try with fix:${C.RESET} ${C.YELLOW}MSW_USE_FIX=true docker compose run repro${C.RESET}`
    )
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(`${C.RED}Error:${C.RESET}`, err)
  process.exit(1)
})
