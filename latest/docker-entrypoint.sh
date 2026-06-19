#!/bin/bash
set -e

# Optional: replicate CircleCI's "no IPv6 egress" condition. Make a hostname
# resolve IPv6-FIRST to a blackholed v6 address and IPv4 to the real server,
# then drop that v6 route so the first (IPv6) Happy-Eyeballs connect attempt
# TIMES OUT. That failing attempt — not a losing-but-successful one — is the
# teardown that orphans MockHttpSocket's snapshot _handle in real CI.
if [ -n "$POISON_V6" ]; then
    BLACKHOLE_V6=fd00:dead:beef:bbbb::1
    # v6 line first so verbatim DNS order attempts IPv6 first.
    echo "$BLACKHOLE_V6 mockhost" >> /etc/hosts
    echo "127.0.0.1 mockhost" >> /etc/hosts
    ip -6 route add blackhole "${BLACKHOLE_V6}/128" 2>/dev/null \
      && echo "🕳  IPv6 $BLACKHOLE_V6 blackholed; mockhost is v6-first->timeout, v4->real" >&2 \
      || echo "⚠️  could not add v6 blackhole route" >&2
fi

# Optional: shrink TCP socket buffers so a write can't fully drain into kernel
# buffers. On loopback the default multi-MB buffers absorb the whole body
# instantly, so the write "completes" at the JS/TLS layer and is never pending
# when the stale-handle cascade destroys the socket — hiding the ECANCELED face.
if [ -n "$TINY_BUF" ]; then
    # Write /proc/sys directly (slim image has no `sysctl` binary).
    echo "4096 8192 16384" > /proc/sys/net/ipv4/tcp_wmem 2>/dev/null || echo "⚠️  tcp_wmem write failed" >&2
    echo "4096 8192 16384" > /proc/sys/net/ipv4/tcp_rmem 2>/dev/null || echo "⚠️  tcp_rmem write failed" >&2
    echo 16384 > /proc/sys/net/core/wmem_max 2>/dev/null || true
    echo 16384 > /proc/sys/net/core/rmem_max 2>/dev/null || true
    echo "🔧 tiny TCP buffers -> tcp_wmem=[$(cat /proc/sys/net/ipv4/tcp_wmem 2>/dev/null)]" >&2
fi

# Optional: apply the Track-S candidate fix (live _handle getter) to the
# installed @mswjs/interceptors before running, to A/B it against baseline.
if [ -n "$MSW_FIX" ]; then
    node /work/apply-fix.mjs || echo "⚠️  fix apply failed" >&2
fi

# Optional: instrument the interceptor to log socket write-state at destroy.
if [ -n "$INSTRUMENT" ]; then
    node /work/instrument.mjs || echo "⚠️  instrument failed" >&2
fi

# Add random delay (275ms ± 225ms) to loopback traffic
# Range: ~50ms to ~500ms
# This will cause some requests to fail (when delay > 250ms) and some to pass (when delay < 250ms)
# proving the race condition threshold.
if [ -n "$NO_NETEM" ]; then
    echo "⏩ netem skipped (NO_NETEM)" >&2
elif tc qdisc add dev lo root netem delay 275ms 225ms distribution normal 2>/dev/null; then
    echo "🎲 Loopback traffic is now RANDOMLY DELAYED (50ms - 500ms)" >&2
else
    echo "⚠️  tc command failed, traffic was not delayed. This may make the issue difficult to reproduce. You may want to consider increasing concurrency (see repro/package.json). Proceeding anyway..." >&2
fi

# Execute the command passed to the container
exec "$@"
