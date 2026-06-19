#!/usr/bin/env node
// Track-S candidate fix #2 (dual-ownership-read): in passthrough, the mock must
// NOT drive reads on the BORROWED handle. MockSocket overrides only the public
// write()/end()/push(); it inherits net.Socket._read, which calls
// this._handle.readStart() on the borrowed TLSWrap while originalSocket is also
// reading it -> "2 owners of one handle" -> read EINVAL. The mock already gets
// response bytes via originalSocket 'data' -> push(), so its _read can be inert.
//
// This fix injects an instance `_read` no-op in passthrough (only for passthrough
// sockets; mocked-response sockets are untouched), KEEPING the #706 _handle alias
// so net.js still sees a handle (no 'connection'-listener push-buffering regress).
import fs from 'fs'
import path from 'path'

const ROOT = process.env.NM_ROOT || '/work/node_modules'
// Inject right after `this.originalSocket = socket;` inside passthrough().
const ANCHOR = /this\.originalSocket = socket;/g
const INJECT =
  'this.originalSocket = socket; this._read = function () {};'

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
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(c?js|mjs)$/.test(e.name)) yield p
  }
}
for (const file of walk(ROOT)) {
  if (!file.includes('@mswjs/interceptors')) continue
  const src = fs.readFileSync(file, 'utf8')
  if (!ANCHOR.test(src)) continue
  ANCHOR.lastIndex = 0
  const out = src.replace(ANCHOR, () => {
    sites++
    return INJECT
  })
  fs.writeFileSync(file, out)
  files++
  console.error(`[apply-fix2] patched ${file}`)
}
console.error(`[apply-fix2] done: ${sites} site(s) across ${files} file(s)`)
if (sites === 0) {
  console.error('[apply-fix2] WARNING: anchor not found — fix NOT applied')
  process.exit(3)
}
