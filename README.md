# @mswjs/interceptors #753 — reproduction testbed (EINVAL / ECANCELED, + the #757 leak)

A fork of `@mswjs/interceptors` used as a **reproduction testbed** for [mswjs/interceptors#753](https://github.com/mswjs/interceptors/issues/753).

> **Status — June 2026.** Root cause and fix are settled. This branch (`tls-write-ecanceled-repro`) reproduces **both** failure faces deterministically — against the **real published packages** — and drives each to **0** with the fix. The original `repro` branch was an earlier, HTTP-only / EINVAL-only attempt; it could never surface the `ECANCELED` write face (that's TLS-only), and is superseded by this branch.

## What's actually going on

`MockHttpSocket.passthrough()` aliases the real socket's `_handle` onto the mock ([#706](https://github.com/mswjs/interceptors/pull/706)). But `MockSocket extends net.Socket` overrides only the *public* `write`/`read`, so it still inherits `net.Socket._read`, which calls `readStart()` on that borrowed handle. Two owners, one handle — and when Node's Happy Eyeballs (`autoSelectFamily`, default-on since Node 20) swaps the underlying socket, the mock acts on a handle that's already gone:

- **read → `read EINVAL`**
- **write → `write ECANCELED "Canceled because of SSL destruction"`** — TLS-only; tearing the mock down `close()`s the shared handle while a write is in flight (mid-handshake), cancelling it.

One root, two faces. **The fix:** override `_read` to a no-op in passthrough **and** drop the #706 alias (below).

Two things that are *not* this bug:
- The **OOM** seen on passthrough-heavy suites is a separate parser-pool leak, fixed upstream by [#757](https://github.com/mswjs/interceptors/pull/757) in 0.41.0. (Isolated here too — see [The memory leak](#the-memory-leak-757--isolated-to-one-commit).)
- The **`--no-network-family-autoselection` flag** only removes the Happy-Eyeballs trigger for `EINVAL`. The write face isn't Happy-Eyeballs-bound and survives the flag — which is why it looked like a complete fix and wasn't.

## The hard part: two purpose-built simulators

In the wild this is a ~1-in-thousands flake. The real engineering here is **two test environments that make each face deterministic against the real package** — so "→ 0" is a measurement, not a hope. Both run real `https.request` → `tls.connect` through the real interceptor; nothing about OpenSSL is faked.

### Simulator 1 — the Happy-Eyeballs swap → `read EINVAL`

The race only misfires under a precise alignment, so the rig recreates all of it at once. Remove any one ingredient and it goes silent:

- **Genuinely dual-stack** (IPv4 + IPv6) — without both, Happy Eyeballs has nothing to race and the bug *cannot* occur. This is the #1 reason people "can't reproduce." (`docker-compose.yml` → the `enable_ipv6` network.)
- **~250 ms loopback delay** via `tc netem` — Happy Eyeballs only opens a *second* connection attempt after a 250 ms timer; sub-millisecond loopback never reaches it. The delay is what makes Node actually open the second socket and swap to it — the instant the borrowed handle goes stale. (See [`repro/docker-entrypoint.sh`](repro/docker-entrypoint.sh).)
- **Thousands of concurrent passthrough requests** — volume to land on the wrong side of the race every run.

```bash
# baseline — the exact stack we run at work (nock@14.0.10 -> @mswjs/interceptors@0.39.8): ~8000 EINVAL/run
docker compose run --rm -e CONCURRENCY=300 -e REQUESTS=8000 repro-work-tls

# with the fix: 0
docker compose run --rm -e MSW_FIX=1 -e FIX_KIND=readnoop-noalias \
  -e CONCURRENCY=300 -e REQUESTS=8000 repro-work-tls
```

### Simulator 2 — the stalled TLS socket → `write ECANCELED`

`ECANCELED "Canceled because of SSL destruction"` is TLS-only and needs a write *in flight* when the handle is closed — so a loopback HTTP repro can never surface it (no SSL, nothing to destroy). That's the part that hid for months. This rig forces the window deterministically:

- A TLS server that accepts but **never finishes the handshake** (`SERVER_MODE=tlsstall`, see [`latest/run-tls.mjs`](latest/run-tls.mjs)), so a real write **parks in OpenSSL** with nowhere to drain.
- A teardown induced **mid-handshake** (`DESTROY_ON_TIMEOUT=1`) — the same teardown nock's cleanup does in CI — closing the shared handle under that write.
- The flag is left **on** (`--no-network-family-autoselection`) to remove the `EINVAL` read-face so it can't pre-empt the write — i.e. it reproduces the exact real-CI "flag present, still crashing" condition.

```bash
# baseline — ~500-900 "Canceled because of SSL destruction" / run, WITH the flag on
docker compose run --rm \
  -e NODE_OPTIONS=--no-network-family-autoselection \
  -e SERVER_MODE=tlsstall -e DESTROY_ON_TIMEOUT=1 -e BODY_KB=512 -e REQ_TIMEOUT_MS=600 \
  -e CONCURRENCY=150 -e REQUESTS=900 repro-work-tls

# with the fix: 0
docker compose run --rm -e MSW_FIX=1 -e FIX_KIND=readnoop-noalias \
  -e NODE_OPTIONS=--no-network-family-autoselection \
  -e SERVER_MODE=tlsstall -e DESTROY_ON_TIMEOUT=1 -e BODY_KB=512 -e REQ_TIMEOUT_MS=600 \
  -e CONCURRENCY=150 -e REQUESTS=900 repro-work-tls
```

### `mechanism.mjs` — the write face in isolation (no nock, no Happy Eyeballs)

A deterministic micro-repro of the exact primitive: a real `TLSSocket` mid-handshake with a pending write, torn down four ways — **A** close the borrowed handle, **B** MSW's exact alias → `mock.destroy()`, **C** `originalSocket.destroy(EINVAL)`, **D** the fix (no alias). **B** (literally MSW's pattern) emits `write ECANCELED "Canceled because of SSL destruction"` 100%; **D** does not.

```bash
docker compose run --rm -e NO_NETEM=1 repro-work-tls node mechanism.mjs
```

## The fix

Applied to the **installed (published) package** at container start by [`latest/apply-fix.mjs`](latest/apply-fix.mjs), so every result is against real shipped code:

```bash
MSW_FIX=1 FIX_KIND=readnoop-noalias   # _read no-op in passthrough + drop the #706 alias  (recommended)
```

Why it doesn't reintroduce #706: with `_read` overridden, the inherited `net.Socket._read` (the thing #706's alias was protecting — it registers a `connect` listener per `push()` when there's no handle) never runs, so dropping the alias is safe. [`latest/regression706.mjs`](latest/regression706.mjs) confirms `listenerCount('connect') === 0` and no `MaxListenersExceededWarning`:

```bash
docker compose run --rm -e NO_NETEM=1 -e MSW_FIX=1 -e FIX_KIND=readnoop-noalias \
  repro-work-tls node regression706.mjs
```

Other `FIX_KIND`s exist to *prove the analysis*, not to ship: `readnoop` (no-op only, keep alias), `getter` (live `_handle` getter — fixes EINVAL only, inferior), `noalias-only` (drop alias *without* the `_read` override → reintroduces #706's leak, a negative control), `revert757` (see below).

## The memory leak (#757) — isolated to one commit

A separate bug: the response parser is returned to Node's pool with `parser.free()`, which doesn't null its `kOn*` callbacks; those retain the socket and every buffered response → the heap climbs to OOM. Fixed upstream by [#757](https://github.com/mswjs/interceptors/pull/757) in 0.41.0. [`latest/mem.mjs`](latest/mem.mjs) profiles it (forced GC between samples), and the fix is isolated by toggling that one commit:

```bash
# 0.39.8 (pre-#757): ~1.25 GB of arrayBuffers retained after GC
docker compose run --rm -e NO_NETEM=1 repro-work-tls node --expose-gc mem.mjs

# 0.41.9 with #757 reverted: the leak comes straight back
docker compose run --rm -e NO_NETEM=1 -e MSW_FIX=1 -e FIX_KIND=revert757 \
  repro-latest-tls node --expose-gc mem.mjs
```

The #753 handle fix is memory-neutral; the leak flips only with #757.

## Layout

| Path / service | What |
|---|---|
| `latest/run-tls.mjs` | HTTPS passthrough harness — `SERVER_MODE` (`drain`/`throttle`/`stall`/`tlsstall`) + body/concurrency/timeout knobs |
| `latest/mechanism.mjs` | deterministic write-face primitive (paths A–D) |
| `latest/apply-fix.mjs` | applies a `FIX_KIND` to the *installed* package |
| `latest/regression706.mjs` | #706 listener-leak regression guard |
| `latest/mem.mjs` | memory profiler |
| `repro/` | original fork-`src`-built harness (Node 24, dual-stack, netem); HTTP / EINVAL |
| `repro-work-tls` *(compose)* | the exact stack we run at work: nock@14.0.10 → interceptors@0.39.8 |
| `repro-latest-tls` *(compose)* | latest published: nock@14.0.15 → interceptors@0.41.9 |

**Env knobs** — via `docker compose run -e`: `SERVER_MODE`, `BODY_KB`, `CONCURRENCY`, `REQUESTS`, `RUNS`, `MAX_SOCKETS`, `TARGET_HOST`, `REQ_TIMEOUT_MS`, `DESTROY_ON_TIMEOUT`, `SERVER_BIND`; entrypoint: `NO_NETEM`, `TINY_BUF`, `POISON_V6`, `MSW_FIX` + `FIX_KIND`, `INSTRUMENT`.

**Dual-stack requirement:** the `enable_ipv6` compose network provides IPv4+IPv6. On Docker Desktop, also set *Settings → Resources → Network → Default networking mode → Dual IPv4/IPv6*. IPv4-only → no `EINVAL`. The `tc netem` delay needs `privileged: true` (already set).

---

<sub>The investigation, the two simulators, and the fix were AI-assisted. All results are reproduction-backed against the real published packages.</sub>
