FROM node:24.16.0-slim

# iproute2 for `tc` (loopback delay), reuse the repro entrypoint
RUN apt-get update && apt-get install -y iproute2 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY latest/package.json ./
# Real, latest published packages: nock@14.0.15 -> @mswjs/interceptors ^0.41.0 (0.41.9)
RUN npm install --no-audit --no-fund
COPY latest/run.mjs ./
COPY repro/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV CI=true
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm", "start"]
