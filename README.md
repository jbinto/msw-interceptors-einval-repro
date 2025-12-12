# @mswjs/interceptors EINVAL/ECANCELED reproduction and fix

This is a fork of `@mswjs/interceptors` and is an attempt to explain/solve https://github.com/mswjs/interceptors/issues/753.

tl;dr In a mixed IPv4/IPv6 environment, under "high" latency (>250ms), Node's Happy Eyeballs implementation swaps out an IPv6 for an IPv4 socket (or vice versa). msw's `MockHttpSocket` `passthrough()` implementation holds on to a `_handle` for the original socket and does not see this "switcheroo". When the old, already-destroyed socket is acted upon, we get errors like EINVAL (when reading) or ECANCELED (when writing to a `TLSSocket`).

There are numerous ways to fix this, but I'm still trying to figure out how to balance this vs https://github.com/mswjs/interceptors/pull/706. Right now, I'm suppressing `_read`, which is enough to stop the EINVAL errors, but I think that's a bit of a hack and not really sufficient.

---

## How to use this repo to reproduce the bug

This repo contains a script which reproduces the bug. It uses the latest version of `nock`, and allows real network requests. It then makes thousands of concurrent HTTP requests to a local server, which triggers the Happy Eyeballs race condition in dual-stack environments.

```bash
git clone https://github.com/jbinto/msw-interceptors-einval-repro.git
cd msw-interceptors-einval-repro
```

### With docker

I've included a Docker setup which:

- checks that you have an IPv4/IPv6 dual stack configured and working _(because without one you cannot reproduce the bug, and you will waste hours trying)_
- alters network conditions to reliably reproduce the race condition (using `tc`, it delays loopback traffic by ~250ms)

Note the network delay requires `privileged: true`, you can disable this in the compose file.

```bash
# Run baseline test (should fail with EINVAL)
MSW_USE_FIX=false docker-compose run repro

# Run test with the fix (should pass)
MSW_USE_FIX=true docker-compose run repro
```

### Without docker

```bash
# Clone and build @mswjs/interceptors
pnpm install
pnpm build

# Setup repro
cd repro
pnpm install

# Test locally (baseline - should FAIL with EINVAL)
MSW_USE_FIX=false node test.js

# Test locally (with fix - should PASS)
MSW_USE_FIX=true node test.js
```

## Background

At my job, we use `nock` in our Node.js test suites to mock external HTTP calls. Nock works by intercepting the built-in Node.js `http` library and allows you to spy on outgoing requests and/or stub out their responses. Nock can be configured either to allow real outbound traffic for unmatched patterns, or to block outbound traffic and to treat any network activity that isn't "covered" as a test failure.

We also subscribe to [Datadog CI Visibility](https://docs.datadoghq.com/continuous_integration/) (via the [dd-trace-js](https://github.com/datadog/dd-trace-js) npm package) to monitor and improve our CI pipelines and test suites. This means while tests are running, telemetry is being collected and submitted to a Datadog ingestion endpoint. We allow `nock` to make unmocked, real network connections to the `datadoghq.com` domain.

The trouble started when we upgraded from `nock@13` to `nock@14` (and also `nock@15.0.0-beta6`). We immediately started experiencing strange `EINVAL`, `ECANCELED`, out of memory errors in our test suites. Disabling `dd-trace` CI telemetry made the errors disappear. Our immediate reaction was that Datadog's heavy monkey-patching + instrumentation was conflicting with the new `interceptors`.

I really want to continue using the (very nice!) CI Visibility product so I started to investigate. I finally figured out that the bad behavior was caused by simply making a large number of real, unmocked HTTP(S) requests while `nock` was loaded and activated in-process. Turns out `dd-trace-js` was just a good load test to expose the issue, rather than a contributing factor.

Ultimately I made a few major discoveries:

### Preventing `_read` from being forwarded from the `MockSocket` to its superclass `net.Socket` resolves the EINVAL issue.

In https://github.com/mswjs/interceptors/pull/706 `MockSocket` was changed to expose the underlying `_handle` of a real socket. That PR solved some memory/resource leaks, by coercing the Node runtime not to make certain calls that subscribed event listeners based on some branching logic that depends on whether `_handle` is defined. Reverting https://github.com/mswjs/interceptors/pull/706 fixed my issue, but brought back the resource leak.

_(I'll be honest, I'm in over my head at this point, I don't really know socket programming or even Node's public socket API all that well. I'm just trying to make fix my CI jobs after a dependency upgrade. I could stop here and declare victory but I really didn't feel comfortable not understanding what's happening.)_

### Happy eyeballs is the root cause

I kept adding logging to `Mock[Http]Socket.ts` and eventually got a stack trace from an error event emitter with a frame for `internalConnectMultiple`. I learned that this is Node's [Happy Eyeballs](https://en.wikipedia.org/wiki/Happy_Eyeballs) implementation.

(\*aside: this is an interesting read, because how Node implements Happy Eyeballs is not the way it is commonly described: https://r1ch.net/blog/node-v20-aggregateeerror-etimedout-happy-eyeballs)

### There is still \_handle confusion

I had an LLM add very nice, detailed logs to `MockHttpSocket.ts`. One thing that became apparent is, even with the `_read` fix, which prevents crashes, it's still clear that in this Happy Eyeballs case, the `_handle` is still stale. We patched over a single case that caused a crash, but I don't think that will be the only one.

I suspect that this explains some other strange behavior I've seen where @mswjs/interceptors and the Playwight VSCode plugin interact poorly (another issue for another day).

## usage of AI/LLM disclaimer

_The majority of this reproduction was directly or indirectly generated by either OpenAI Codex, Claude Sonnet 4.5 or Gemini Pro 3. This work spanned a few weeks and several dozen discussions and agent interactions to reason through the problem, analyze logs, run tests, write code, and write documentation. The vast majority of the written content and code is machine-generated. This README was written entirely by [me](https://github.com/jbinto), but other than that it's :robot: all the way down._
