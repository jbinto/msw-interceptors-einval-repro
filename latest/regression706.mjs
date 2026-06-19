#!/usr/bin/env node
// Regression guard for PR #706 (nock#2830 MaxListenersExceeded / push-buffering).
// With the readnoop-noalias fix, the mock has NO `_handle` and its `_read` is a
// no-op, so the inherited net.Socket._read (which would register a 'connect'
// listener per push when there's no handle) NEVER runs. This asserts the fix
// does not reintroduce the listener leak: listenerCount('connect') stays 0,
// no MaxListenersExceededWarning fires, and the passthrough response is intact.
import http from 'http'
import nock from 'nock'

let warned = false
process.on('warning', (w) => {
  if (/MaxListenersExceeded/.test(String(w && w.name) + String(w && w.message))) {
    warned = true
    console.log('[706] !! MaxListenersExceededWarning fired')
  }
})

nock.enableNetConnect()

const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    // Multiple writes -> multiple reads on the mock (the #706 trigger).
    res.writeHead(200)
    res.write('hello ')
    res.write('world')
    setTimeout(() => res.end('!'), 10)
  })
})

function once() {
  return new Promise((resolve) => {
    const port = server.address().port
    const req = http.request({ port, method: 'GET', path: '/' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        const connectListeners = req.socket?.listenerCount('connect') ?? -1
        resolve({ body, connectListeners })
      })
    })
    req.on('error', (e) => resolve({ error: e.code }))
    req.end()
  })
}

server.listen(0, '127.0.0.1', async () => {
  const N = parseInt(process.env.N || '200', 10)
  let maxConnectListeners = 0
  let lastBody = ''
  let errors = 0
  for (let i = 0; i < N; i++) {
    const r = await once()
    if (r.error) { errors++; continue }
    lastBody = r.body
    if (r.connectListeners > maxConnectListeners) maxConnectListeners = r.connectListeners
  }
  console.log(`[706] requests=${N} errors=${errors} bodyOK=${lastBody === 'hello world!'} ("${lastBody}")`)
  console.log(`[706] max listenerCount('connect') across requests: ${maxConnectListeners}`)
  console.log(`[706] MaxListenersExceededWarning fired: ${warned}`)
  const pass = errors === 0 && lastBody === 'hello world!' && maxConnectListeners === 0 && !warned
  console.log(pass ? '[706] ✅ PASS (no leak, response intact)' : '[706] ❌ FAIL')
  server.close()
  process.exit(pass ? 0 : 1)
})
