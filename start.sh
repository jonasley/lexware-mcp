#!/bin/zsh
# Start the Lexware MCP server locally with .env (read-only, bound to 127.0.0.1).
cd "$(dirname "$0")"
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
exec node --env-file=.env dist/server.js
