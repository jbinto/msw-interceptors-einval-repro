# Multi-architecture support
FROM --platform=$BUILDPLATFORM node:20.19.5-slim

# Install OpenSSL for certificate generation
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Copy the entire interceptors project
COPY . .

# Install pnpm
RUN npm install -g pnpm@10.23.0

# Build the parent project to generate lib/ files
ENV CI=true
RUN pnpm install --no-frozen-lockfile || true

# Set working directory to repro folder
WORKDIR /workspace/repro

# Install repro dependencies
RUN pnpm install --no-frozen-lockfile

# Make test.js executable
RUN chmod +x test.js

# Default command shows available scripts
CMD ["sh", "-c", "echo 'Available commands:' && echo '  pnpm test:baseline' && echo '  pnpm test:fix' && echo '  pnpm test:matrix:baseline' && echo '  pnpm test:matrix:fix' && echo '' && echo 'Run: docker run --rm einval-repro pnpm test:baseline'"]
