#!/usr/bin/env bash
# ============================================================================
# install.sh — one-line installer for the Chess Probability Visualizer.
#
#   curl -fsSL https://raw.githubusercontent.com/Tom-A-Rom/StochaHackathonSS26/main/install.sh | bash
#
# Clones (or updates) the repo and starts a local server in your browser.
# Override the install location:
#   curl -fsSL .../install.sh | bash -s -- ~/my/path
# ============================================================================
set -euo pipefail

REPO_URL="https://github.com/Tom-A-Rom/StochaHackathonSS26.git"
TARGET="${1:-${HOME}/StochaHackathonSS26}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required but not installed."

# Need at least one static-file server.
if ! command -v python3 >/dev/null 2>&1 \
   && ! command -v python >/dev/null 2>&1 \
   && ! command -v npx >/dev/null 2>&1 \
   && ! command -v php >/dev/null 2>&1; then
  die "need python3, python, node/npx or php to run the local server."
fi

if [ -d "${TARGET}/.git" ]; then
  say "Updating existing checkout in ${TARGET}"
  git -C "${TARGET}" pull --ff-only
else
  say "Cloning into ${TARGET}"
  git clone --depth 1 "${REPO_URL}" "${TARGET}"
fi

chmod +x "${TARGET}/serve.sh"

say "Starting the local server …"
exec "${TARGET}/serve.sh"
