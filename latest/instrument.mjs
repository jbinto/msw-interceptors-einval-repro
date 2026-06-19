#!/usr/bin/env node
// Instrument the INSTALLED @mswjs/interceptors to prove the ECANCELED mechanism.
// At the passthrough error cascade — `this.once("error", e => socket.destroy(e))`
// — log the real socket's write state at the instant of destroy. If a TLS write
// is genuinely pending (writableLength > 0 / bufferSize > 0) yet we never see
// ECANCELED, the cascade-with-pending-write theory is wrong. If writableLength
// is always 0, the body already drained — confirming the buffer hypothesis.
import fs from 'fs'
import path from 'path'

const ROOT = process.env.NM_ROOT || '/work/node_modules'

// Match the compiled cascade block (whitespace-tolerant), both .mjs and .cjs.
const CASCADE =
  /this\.once\("error",\s*\(error\)\s*=>\s*\{\s*socket\.destroy\(error\);\s*\}\);/g
const INSTRUMENTED = `this.once("error", (error) => {
  try { console.error("[INSTR] cascade-destroy code=" + (error&&error.code) + " ctor=" + (socket.constructor&&socket.constructor.name) + " encrypted=" + socket.encrypted + " handleType=" + (socket._handle&&socket._handle.constructor&&socket._handle.constructor.name) + " writableLength=" + socket.writableLength + " writableFinished=" + socket.writableFinished + " destroyed=" + socket.destroyed); } catch(_e){}
  const _origEmit = socket.emit.bind(socket);
  socket.emit = (ev, ...a) => { if (ev === "error" && a[0] && a[0].code === "ECANCELED") { try { console.error("[INSTR] ECANCELED on real socket: " + a[0].message); } catch(_e){} } return _origEmit(ev, ...a); };
  socket.destroy(error);
});`

let files = 0
let sites = 0
function* walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      yield* walk(p)
    } else if (/\.(c?js|mjs)$/.test(e.name)) {
      yield p
    }
  }
}
for (const file of walk(ROOT)) {
  if (!file.includes('@mswjs/interceptors')) continue
  const src = fs.readFileSync(file, 'utf8')
  if (!CASCADE.test(src)) continue
  CASCADE.lastIndex = 0
  const out = src.replace(CASCADE, () => {
    sites++
    return INSTRUMENTED
  })
  fs.writeFileSync(file, out)
  files++
  console.error(`[instrument] patched ${file}`)
}
console.error(`[instrument] done: ${sites} site(s) across ${files} file(s)`)
if (sites === 0) {
  console.error('[instrument] WARNING: cascade not found — not instrumented')
  process.exit(3)
}
