# EINVAL Bug Reproduction & Fix Validation

This directory contains a minimal reproduction case for the "read EINVAL" error that occurs at high concurrency when using `@mswjs/interceptors` with HTTP clients like `dd-trace`.

## The Problem

At ~200+ concurrent HTTPS requests, the interceptor throws:

```
Error: read EINVAL
```

**Environment**: Reproduces on **macOS ARM64 native** and **Linux CI environments**, but **NOT in Docker Linux** on Mac. This indicates platform-specific socket handling differences.

## The Fix

**Solution**: Skip `_read()` when in passthrough mode.

Controlled by environment variable: `MSW_MODIFIED_BEHAVIOR_TYPE_A=true`

## Quick Start

### Local Execution

```bash
# Install dependencies
pnpm install

# Run failing test (baseline - shows EINVAL on macOS native)
pnpm test:baseline

# Run passing test (with fix)
pnpm test:fix

# Run full test matrix (baseline)
pnpm test:matrix:baseline

# Run full test matrix (with fix)
pnpm test:matrix:fix

# Run specific concurrency levels
pnpm test:baseline:200    # Baseline at 200 concurrency
pnpm test:fix:200         # With fix at 200 concurrency
pnpm test:baseline:500    # Baseline at 500 concurrency
pnpm test:fix:500         # With fix at 500 concurrency
```

### Docker Execution (Controlled Environment)

```bash
# Build image from parent directory (native architecture)
cd .. && docker build -f repro/Dockerfile -t einval-repro . && cd repro

# Run failing test (baseline - will NOT show EINVAL in Docker)
docker run --rm einval-repro pnpm test:baseline

# Run passing test (with fix)
docker run --rm einval-repro pnpm test:fix

# Run full test matrix (baseline)
docker run --rm einval-repro pnpm test:matrix:baseline

# Run full test matrix (with fix)
docker run --rm einval-repro pnpm test:matrix:fix

# Force x86/amd64 architecture (useful on ARM Macs)
cd .. && docker build --platform linux/amd64 -f repro/Dockerfile -t einval-repro:x86 . && cd repro
docker run --rm --platform linux/amd64 einval-repro:x86 pnpm test:baseline
docker run --rm --platform linux/amd64 einval-repro:x86 pnpm test:fix
```

**⚠️ Important Note**: The bug reproduces **natively on macOS ARM64** but **NOT in Docker Linux** (even when running on Mac). This suggests the issue is specific to macOS networking/socket implementation, not pure Linux. The original CI failures were on Linux, so environment-specific factors may be involved.

## Available Scripts

```bash
pnpm test:baseline          # Run baseline test (TYPE_A disabled, 300 concurrency)
pnpm test:fix               # Run with fix (TYPE_A enabled, 300 concurrency)
pnpm test:matrix:baseline   # Run matrix test without fix
pnpm test:matrix:fix        # Run matrix test with fix
pnpm test:baseline:100      # Baseline at 100 concurrency
pnpm test:baseline:200      # Baseline at 200 concurrency
pnpm test:baseline:300      # Baseline at 300 concurrency
pnpm test:baseline:500      # Baseline at 500 concurrency
pnpm test:fix:100           # With fix at 100 concurrency
pnpm test:fix:200           # With fix at 200 concurrency
pnpm test:fix:300           # With fix at 300 concurrency
pnpm test:fix:500           # With fix at 500 concurrency
```

## CLI Options (Direct Invocation)

```
-c, --concurrency  Number of concurrent requests (default: 300)
-r, --requests     Total number of requests (default: 2000)
-m, --matrix       Run full test matrix at 100/200/300/500 concurrency
-h, --help         Show help

Note: Set MSW_MODIFIED_BEHAVIOR_TYPE_A=true to enable the fix
```

## Files

- `test.js` - All-in-one test runner with CLI options
- `mock-dd-server.js` - Local mock Datadog telemetry server (no auth needed)
- `Dockerfile` - Containerized environment for consistent reproduction

## Test Matrix

The test matrix validates the fix at multiple concurrency levels:

| Concurrency | Baseline (no fix) | With TYPE_A Fix |
| ----------- | ----------------- | --------------- |
| 100         | ❌ FAIL (EINVAL)  | ✅ PASS         |
| 200         | ❌ FAIL (EINVAL)  | ✅ PASS         |
| 300         | ❌ FAIL (EINVAL)  | ✅ PASS         |
| 500         | ❌ FAIL (EINVAL)  | ✅ PASS         |

## Implementation

The fix is in `src/interceptors/ClientRequest/MockHttpSocket.ts`:

```typescript
public _read(size: number): void {
  if (process.env.MSW_MODIFIED_BEHAVIOR_TYPE_A === 'true') {
    if (this.socketState === 'passthrough') {
      // In passthrough mode, the originalSocket handles reading.
      // Skip _read() to avoid triggering Node.js handle checks that cause EINVAL.
      return;
    }
  }
  super._read(size)
}
```

## Why This Works

In passthrough mode:

1. The `originalSocket` handles all data reading
2. Calling `super._read()` triggers Node.js internals that perform handle state checks
3. When the handle state doesn't match expectations, `tryReadStart()` throws EINVAL
4. Skipping `_read()` in passthrough mode avoids this code path entirely

The fix preserves correct behavior:

- ✅ Mock mode still works (calls `super._read()`)
- ✅ Passthrough delegates reading to the original socket
- ✅ No buffering issues (preserves `_handle` shadowing)
