FROM node:20-slim AS build

WORKDIR /app

# System deps for sharp, yt-dlp, WARP proxy
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

# Build
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY . .
# Overlay WARP binaries (wgcf + wireproxy) — downloaded by postinstall in build stage
COPY --from=build /app/bin ./bin

EXPOSE 3000

RUN chmod +x scripts/fly-entry.sh

CMD ["scripts/fly-entry.sh"]
