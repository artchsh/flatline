#!/bin/sh
# Stamp the backend URL into the prebuilt bundle, then run nginx.
#
# Vite inlines VITE_FLATLINE_URL at build time. The image is built once with
# a __FLATLINE_URL__ placeholder; this script swaps in the real origin on
# every start so the same image works behind any host or reverse proxy.
set -eu

PLACEHOLDER="__FLATLINE_URL__"
TARGET="${FLATLINE_URL:-http://127.0.0.1:3001}"

# Only the hashed asset files contain the URL; index.html has no env in it.
# Pipe delimiter because URLs contain slashes.
grep -rl "$PLACEHOLDER" /usr/share/nginx/html/assets/ 2>/dev/null | while IFS= read -r file; do
    sed -i "s|$PLACEHOLDER|$TARGET|g" "$file"
done

echo "dashboard: backend at $TARGET"
exec "$@"
