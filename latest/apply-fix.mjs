#!/usr/bin/env node
// Track-S candidate fixes for #753, applied to the INSTALLED (compiled)
// @mswjs/interceptors so we validate against the real shipped package.
// Select with FIX_KIND:
//   getter           : _handle becomes a live getter onto originalSocket._handle
//                      (fixes staleness; KEEPS dual-owner readStart — weaker)
//   readnoop         : inject a passthrough `_read` no-op, KEEP the #706 alias
//                      (candidate (a): mock never drives readStart on the handle)
//   readnoop-noalias : `_read` no-op AND drop the #706 alias entirely
//                      (candidate (a)+(d): mock never touches the handle at all —
//                       recommended; base _read never runs so #706's listener
//                       leak cannot recur)
import fs from 'fs'
import path from 'path'

const ROOT = process.env.NM_ROOT || '/work/node_modules'
const KIND = process.env.FIX_KIND || 'getter'

// The compiled #706 alias block (whitespace-tolerant).
const ALIAS =
  /Object\.defineProperty\(this, "_handle", \{\s*value: socket\._handle,\s*enumerable: true,\s*writable: true\s*\}\);/g
const LIVE_GETTER_BODY =
  'Object.defineProperty(this, "_handle", { get() { return this.originalSocket?._handle ?? null; }, set() {}, enumerable: true, configurable: true });'
// Anchor to inject a passthrough _read no-op right after originalSocket is set.
const ANCHOR = /this\.originalSocket = socket;/g
const INJECT_READNOOP = 'this.originalSocket = socket; this._read = function () {};'

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

let files = 0
let edits = 0
for (const file of walk(ROOT)) {
  if (!file.includes('@mswjs/interceptors')) continue
  let src = fs.readFileSync(file, 'utf8')
  const before = src

  if (KIND === 'getter') {
    src = src.replace(ALIAS, () => {
      edits++
      return LIVE_GETTER_BODY
    })
  } else if (KIND === 'revert757') {
    // PROOF probe: undo upstream #757 on 0.41.x — swap freeParser(...) back to
    // the old parser.free() (which pools the parser WITHOUT nulling its kOn*
    // callbacks/socket refs). If the passthrough leak returns, #757 is the fix.
    const n1 = src.split('freeParser(this.requestParser, this)').length - 1
    const n2 = src.split('freeParser(this.responseParser, this)').length - 1
    src = src
      .split('freeParser(this.requestParser, this)').join('this.requestParser.free()')
      .split('freeParser(this.responseParser, this)').join('this.responseParser.free()')
    edits += n1 + n2
  } else if (KIND === 'noalias-only') {
    // NEGATIVE CONTROL: drop the #706 alias but DON'T add the _read override.
    // This should reintroduce the #706 leak (inherited _read with no handle
    // registers a 'connect' listener per push) — proving the _read override is
    // the load-bearing part, not merely removing the alias.
    src = src.replace(ALIAS, () => {
      edits++
      return '/* #706 alias removed; NO _read override (negative control) */;'
    })
  } else if (KIND === 'readnoop' || KIND === 'readnoop-noalias') {
    if (ANCHOR.test(src)) {
      ANCHOR.lastIndex = 0
      src = src.replace(ANCHOR, () => {
        edits++
        return INJECT_READNOOP
      })
    }
    if (KIND === 'readnoop-noalias') {
      src = src.replace(ALIAS, () => {
        edits++
        return '/* #706 _handle alias removed (mock must not own the handle) */;'
      })
    }
  } else {
    console.error(`[apply-fix] unknown FIX_KIND=${KIND}`)
    process.exit(2)
  }

  if (src !== before) {
    fs.writeFileSync(file, src)
    files++
    console.error(`[apply-fix] (${KIND}) patched ${file}`)
  }
}
console.error(`[apply-fix] FIX_KIND=${KIND} done: ${edits} edit(s) across ${files} file(s)`)
if (edits === 0) {
  console.error('[apply-fix] WARNING: nothing patched')
  process.exit(3)
}
