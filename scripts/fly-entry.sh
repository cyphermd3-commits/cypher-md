#!/bin/sh
set -e

# Write secrets from env vars to files (Fly.io web UI secrets are env vars)
mkdir -p /etc/secrets
[ -n "$WARP_CONF" ] && printf '%s\n' "$WARP_CONF" > /etc/secrets/warp.conf
[ -n "$YT_COOKIES" ] && printf '%s\n' "$YT_COOKIES" > /etc/secrets/cookies.txt

exec node src/server.js
