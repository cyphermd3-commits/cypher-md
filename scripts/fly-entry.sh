#!/bin/sh
set -e

# Persist data on the Fly.io volume at /data
if [ -d /data ]; then
  # auth_info
  if [ ! -L /app/auth_info ] && [ ! -e /app/auth_info ]; then
    mkdir -p /data/auth_info
    ln -s /data/auth_info /app/auth_info
  fi

  # allowed_numbers.json
  if [ ! -L /app/allowed_numbers.json ] && [ ! -f /app/allowed_numbers.json ]; then
    touch /data/allowed_numbers.json
    ln -s /data/allowed_numbers.json /app/allowed_numbers.json
  fi

  # vv_data_*.json files - create link pattern
  for f in /data/vv_data_*.json; do
    [ -f "$f" ] || continue
    bn=$(basename "$f")
    [ ! -e "/app/$bn" ] && ln -s "$f" "/app/$bn"
  done
fi

# Write secrets from env vars to files (Fly.io doesn't have Secret Files)
mkdir -p /etc/secrets
[ -n "$WARP_CONF" ] && printf '%s\n' "$WARP_CONF" > /etc/secrets/warp.conf
[ -n "$YT_COOKIES" ] && printf '%s\n' "$YT_COOKIES" > /etc/secrets/cookies.txt

exec node src/server.js
