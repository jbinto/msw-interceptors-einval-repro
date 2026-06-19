# @mswjs/interceptors #753 — reproduction testbed (EINVAL / ECANCELED, + the #757 leak)

> **Authored by [Claude Code](https://claude.com/claude-code).** The reproduction harnesses, the two simulators, the fix, and this README were written by Claude Code (Anthropic's agentic coding tool), human-directed and human-reviewed. Every result here is reproduction-backed against the real published packages.

A fork of `@mswjs/interceptors` used as a **reproduction testbed** for [mswjs/interceptors#753](https://github.com/mswjs/interceptors/issues/753).

> **Status — June 2026.** Root cause and fix are settled. This testbed reproduces **both** failure faces deterministically — against the **real published packages** — and drives each to **0** with the fix. It started life as an HTTP-only reproduction that only ever surfaced `read EINVAL`; the `write ECANCELED` face is TLS-only and was added later, together with the fix and its verification.

## What's actually going on

`MockHttpSocket.passthrough()` aliases the real socket's `_handle` onto the mock ([#706](https://github.com/mswjs/interceptors/pull/706)). But `MockSocket extends net.Socket` overrides only the public `write`/`read` methods — it leaves `_read` alone, so it inherits `net.Socket`'s own `_read` — and the moment the stream tries to pull data, that inherited `_read` calls `readStart()` on the `_handle` it's holding: the borrowed one. Two owners, one handle — and when Node's Happy Eyeballs (`autoSelectFamily`, default-on since Node 20) swaps the underlying socket, the mock acts on a handle that's already gone:

- **read → `read EINVAL`**
- **write → `write ECANCELED "Canceled because of SSL destruction"`** — TLS-only; tearing the mock down (as nock's cleanup does) `close()`s the shared handle while a write is in flight (mid-handshake), cancelling it.

One root, two faces. **The fix:** override `_read` to a no-op in passthrough **and** drop the #706 alias (below).

Two things that are *not* this bug:
- The **OOM** seen on passthrough-heavy suites is a separate parser-pool leak, fixed upstream by [#757](https://github.com/mswjs/interceptors/pull/757) in 0.41.0. (Isolated here too — see [The memory leak](#the-memory-leak-757--isolated-to-one-commit).)
- The **`--no-network-family-autoselection` flag** only removes the Happy-Eyeballs trigger for `EINVAL`. The write face isn't Happy-Eyeballs-bound and survives the flag — which is why it looked like a complete fix and wasn't.

## The hard part: two purpose-built simulators

In the wild this fires maybe once in a few thousand requests, which is what makes it so hard to chase. So the work that actually mattered here wasn't the fix — it was building **two environments that turn each failure face into something you can trigger at will, against the real published package.** That's what makes the "→ 0" figures below worth trusting: they reproduce on every run. Both simulators drive a real `https.request` → `tls.connect` through the real interceptor; nothing about the socket or OpenSSL is stubbed out.

### Simulator 1 — the Happy-Eyeballs swap → `read EINVAL`

The race only goes wrong when a few things line up at once, so the rig assembles all of them on purpose. Pull any single piece and it vanishes:

- **A genuinely dual-stack host** (IPv4 *and* IPv6). If only one family is reachable, Happy Eyeballs has nothing to race and the bug simply can't occur — this is the number-one reason people try to reproduce #753 and come up empty. (Provided by the `enable_ipv6` network in `docker-compose.yml`.)
- **A ~250 ms loopback delay**, added with `tc netem`. Happy Eyeballs only opens its *second* connection attempt after a 250 ms timer, and on a normal sub-millisecond loopback that timer never fires — so the second socket never opens and nothing ever swaps. The delay is what forces the race: it drags the first attempt out past 250 ms, Node opens the second socket and swaps to it, and the borrowed handle goes stale at exactly that moment. (See [`repro/docker-entrypoint.sh`](repro/docker-entrypoint.sh).)
- **Thousands of concurrent passthrough requests** — at this volume, against the 250 ms delay, essentially every request ends up on the losing side, so a baseline run logs ~8000 `EINVAL`s rather than the handful you'd see in the wild.

(The read face isn't TLS-specific — it first turned up on a plain-HTTP rig — but this testbed runs both faces through the same TLS harness, so Simulator 1 reproduces `EINVAL` over `tls.connect` too.)

```bash
# baseline — the exact stack we run at work (nock@14.0.10 -> @mswjs/interceptors@0.39.8): ~8000 EINVAL/run
docker compose run --rm -e CONCURRENCY=300 -e REQUESTS=8000 repro-work-tls

# with the fix: 0
docker compose run --rm -e MSW_FIX=1 -e FIX_KIND=readnoop-noalias \
  -e CONCURRENCY=300 -e REQUESTS=8000 repro-work-tls
```

### Simulator 2 — the stalled TLS socket → `write ECANCELED`

This is the face that stayed hidden for months, and it's not hard to see why. `ECANCELED "Canceled because of SSL destruction"` can only happen over TLS, and only when a write is still *in flight* at the moment the handle closes. A plain-HTTP loopback reproduction will never show it — no TLS layer means nothing to "destroy." To get it on demand, you have to manufacture that narrow window deliberately:

- **A TLS server that accepts the connection but never finishes the handshake** (`SERVER_MODE=tlsstall`, in [`latest/run-tls.mjs`](latest/run-tls.mjs)). The client's write then parks inside OpenSSL with nowhere to drain — exactly the in-flight state we need.
- **A teardown triggered mid-handshake** (`DESTROY_ON_TIMEOUT=1`), closing the shared handle out from under that pending write. This stands in for the teardown nock performs when it tears a request down during cleanup.
- **The flag left on** (`--no-network-family-autoselection`), which removes the `EINVAL` read-face so it can't pre-empt the write.

The stalled handshake is an engineered stand-in, not the literal sequence CI runs — but it recreates the condition that left people stuck: the flag is applied and the suite still crashes, this time on the write.

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

The simulators show the bug happening; this shows why. It strips the situation down to the bare primitive — a real `TLSSocket` caught mid-handshake with a pending write — and tears it down four different ways:

- **A** — close the borrowed handle directly
- **B** — the interceptor's alias-then-destroy, reproduced by hand: a second socket borrows the handle, then its own `mock.destroy()` closes it
- **C** — `originalSocket.destroy(EINVAL)`
- **D** — the fix: no borrowed handle at all

**B is the pattern `MockHttpSocket` uses today, and it emits `write ECANCELED "Canceled because of SSL destruction"` every single time. D — the fix — never does.**

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

Other `FIX_KIND`s exist to *prove the analysis*, not to ship: `readnoop` (no-op only, keep alias), `getter` (live `_handle` getter — fixes EINVAL only, so the write face still fires), `noalias-only` (drop alias *without* the `_read` override → reintroduces #706's leak, a negative control), `revert757` (see below).

## The memory leak (#757) — isolated to one commit

A separate bug: the response parser is returned to Node's pool with `parser.free()`, which doesn't null its `kOn*` callbacks; those retain the socket and every buffered response → the heap climbs to OOM. Fixed upstream by [#757](https://github.com/mswjs/interceptors/pull/757) in 0.41.0. [`latest/mem.mjs`](latest/mem.mjs) profiles it (forced GC between samples), and the fix is isolated by toggling that one commit:

```bash
# 0.39.8 (pre-#757): arrayBuffers climb to ~1.25 GB and stay there after GC
docker compose run --rm -e NO_NETEM=1 -e REQUESTS=20000 repro-work-tls node --expose-gc mem.mjs

# stock 0.41.9: flat (~0.2 MB retained) — the leak is gone
docker compose run --rm -e NO_NETEM=1 -e REQUESTS=20000 repro-latest-tls node --expose-gc mem.mjs

# 0.41.9 with #757 reverted: the leak comes straight back
docker compose run --rm -e NO_NETEM=1 -e REQUESTS=20000 -e MSW_FIX=1 -e FIX_KIND=revert757 \
  repro-latest-tls node --expose-gc mem.mjs
```

> Volume matters here: the leak is proportional to total passthrough bytes, so pin `REQUESTS=20000` to see the full ~1.25 GB (the compose default of 8000 still shows it clearly at ~0.5 GB). The #753 handle fix is memory-neutral; the leak flips only with #757.

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
