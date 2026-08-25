#!/usr/bin/env bash
# ============================================================================
# One-shot local setup: installs dependencies AND the browser binaries
# Playwright needs (Chromium/Firefox/WebKit) plus their OS-level deps -
# nothing to install manually, no system browser required.
#
# Usage: ./scripts/setup.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Installing dependencies =========================================="
npm ci

echo ""
echo "== Installing Playwright browsers ===================================="
npx playwright install --with-deps

echo ""
echo "Setup complete. Try: npm test"
