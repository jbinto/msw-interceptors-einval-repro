FROM node:24.16.0-slim

# Installing iproute2 for `tc` to slow down network
RUN apt-get update && apt-get install -y iproute2 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.23.0

# Install @mswjs/interceptors dependencies
WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
ENV CI=true
RUN pnpm install --no-frozen-lockfile

# Build @mswjs/interceptors
COPY . .
RUN pnpm build

# Install repro dependencies
WORKDIR /workspace/repro
COPY repro/package.json repro/pnpm-lock.yaml ./repro/
RUN pnpm install --no-frozen-lockfile

# Entrypoint checks for ipv4/ipv6 dual stack and sets up network delay
RUN chmod +x /workspace/repro/docker-entrypoint.sh
ENTRYPOINT ["/workspace/repro/docker-entrypoint.sh"]
CMD ["sh", "-c", "echo 'Please use docker-compose up repro'"]
