#!/bin/bash
set -e

# Add random delay (275ms ± 225ms) to loopback traffic
# Range: ~50ms to ~500ms
# This will cause some requests to fail (when delay > 250ms) and some to pass (when delay < 250ms)
# proving the race condition threshold.
if tc qdisc add dev lo root netem delay 275ms 225ms distribution normal 2>/dev/null; then
    echo "🎲 Loopback traffic is now RANDOMLY DELAYED (50ms - 500ms)" >&2
else
    echo "⚠️  tc command failed, traffic was not delayed. This may make the issue difficult to reproduce. You may want to consider increasing concurrency (see repro/package.json). Proceeding anyway..." >&2
fi

# Execute the command passed to the container
exec "$@"
