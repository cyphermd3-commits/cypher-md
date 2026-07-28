FROM node:20-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ curl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY scripts ./scripts

RUN npm install --ignore-scripts

# Download WARP binaries (wgcf + wireproxy) — our postinstall
RUN node scripts/download-warp.js

# Download yt-dlp directly (bypasses GitHub API rate limit)
RUN curl -fsSL -o node_modules/youtube-dl-exec/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && \
    chmod +x node_modules/youtube-dl-exec/bin/yt-dlp

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/bin ./bin
COPY . .

EXPOSE 3000

RUN chmod +x scripts/fly-entry.sh

CMD ["scripts/fly-entry.sh"]
