#!/bin/zsh
set -e
cd "${0:A:h}"
export PATH="$PWD/../.runtime/node-v22.16.0-darwin-arm64/bin:$PATH"
export COREPACK_HOME="$PWD/../.runtime/corepack"
corepack pnpm --filter ui-tars-desktop exec electron-vite dev
