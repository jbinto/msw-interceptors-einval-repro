#!/bin/bash
set -e

# Check for IPv4/IPv6 dual stack support
check_dual_stack() {
    echo "🔍 Checking for dual stack support..." >&2
    
    local has_ipv4=false
    local has_ipv6=false
    local dns_ipv4_ok=false
    local dns_ipv6_ok=false
    
    # Check for IPv4 (non-loopback)
    if ip -4 addr show | grep -q "inet "; then
        has_ipv4=true
        echo "  ✓ IPv4 interface detected" >&2
    fi
    
    # Check for IPv6 (non-loopback, non-link-local)
    if ip -6 addr show | grep -q "inet6" && ip -6 addr show | grep -v "inet6 ::1" | grep -v "inet6 fe80:" | grep -q "inet6"; then
        has_ipv6=true
        echo "  ✓ IPv6 interface detected" >&2
    fi
    
    # Test DNS resolution for localhost
    echo "  🔍 Testing DNS resolution..." >&2
    if getent ahosts localhost | grep -q "127\.0\.0\.1"; then
        dns_ipv4_ok=true
        echo "    ✓ localhost resolves to IPv4" >&2
    fi
    
    if getent ahosts localhost | grep -q "::1"; then
        dns_ipv6_ok=true
        echo "    ✓ localhost resolves to IPv6" >&2
    fi
    
    # Test DNS resolution for google.com
    if getent ahosts google.com 2>/dev/null | grep -q "STREAM"; then
        if getent ahosts google.com 2>/dev/null | grep -E "[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" | grep -q "STREAM"; then
            echo "    ✓ google.com resolves to IPv4" >&2
        fi
        if getent ahosts google.com 2>/dev/null | grep -E ":" | grep -v "::ffff:" | grep -q "STREAM"; then
            echo "    ✓ google.com resolves to IPv6" >&2
        fi
    fi
    
    # Evaluate results
    if [ "$has_ipv4" = true ] && [ "$has_ipv6" = true ] && [ "$dns_ipv4_ok" = true ] && [ "$dns_ipv6_ok" = true ]; then
        echo "✅ IPv4/IPv6 dual stack detected and DNS resolution working. Proceeding with tests..." >&2
        return 0
    else
        if [ "${REPRO_IGNORE_DUAL_STACK}" = "true" ]; then
            echo "⚠️  Dual stack not fully configured, but REPRO_IGNORE_DUAL_STACK=true. Continuing anyway..." >&2
            if [ "$has_ipv4" = false ]; then echo "    ⚠️  IPv4 interface not detected" >&2; fi
            if [ "$has_ipv6" = false ]; then echo "    ⚠️  IPv6 interface not detected" >&2; fi
            if [ "$dns_ipv4_ok" = false ]; then echo "    ⚠️  localhost does not resolve to IPv4" >&2; fi
            if [ "$dns_ipv6_ok" = false ]; then echo "    ⚠️  localhost does not resolve to IPv6" >&2; fi
            return 0
        else
            echo "❌ This reproduction requires a properly configured dual IPv4/IPv6 stack. Issues found:" >&2
            if [ "$has_ipv4" = false ]; then echo "    ✗ IPv4 interface not detected" >&2; fi
            if [ "$has_ipv6" = false ]; then echo "    ✗ IPv6 interface not detected" >&2; fi
            if [ "$dns_ipv4_ok" = false ]; then echo "    ✗ localhost does not resolve to IPv4" >&2; fi
            if [ "$dns_ipv6_ok" = false ]; then echo "    ✗ localhost does not resolve to IPv6" >&2; fi
            echo "   To override this behavior, set REPRO_IGNORE_DUAL_STACK=true" >&2
            exit 1
        fi
    fi
}

# Run dual stack check
check_dual_stack

# Add random delay (275ms ± 225ms) to loopback traffic
# Range: ~50ms to ~500ms
# This will cause some requests to fail (when delay > 250ms) and some to pass (when delay < 250ms)
# proving the race condition threshold.
if tc qdisc add dev lo root netem delay 275ms 225ms distribution normal 2>/dev/null; then
    echo "🎲 Loopback traffic is now RANDOMLY DELAYED (50ms - 500ms)" >&2
else
    echo "⚠️  tc command failed, traffic was not delayed. This may affect results. Proceeding anyway..." >&2
fi

# Execute the command passed to the container
exec "$@"
