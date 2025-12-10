#!/bin/bash
# Install iproute2 (needed for tc/netem)
apt-get update && apt-get install -y iproute2

# Add random delay (275ms ± 225ms) to loopback traffic
# Range: ~50ms to ~500ms
# This will cause some requests to fail (when delay > 250ms) and some to pass (when delay < 250ms)
# proving the race condition threshold.
tc qdisc add dev lo root netem delay 275ms 225ms distribution normal

# Run the test
echo "🎲 Loopback traffic is now RANDOMLY DELAYED (50ms - 500ms)"
echo "🚀 Running test..."
pnpm test:baseline