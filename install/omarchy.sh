#!/usr/bin/env bash
# TeleOps for Omarchy — installs (or updates) TeleOps for the current user:
#
#   curl -fsSL https://raw.githubusercontent.com/emrgim/TeleOps/main/install/omarchy.sh | bash
#
# Same as the Linux install (systemd user service, auto-update), and "TeleOps" opens as an
# Omarchy web app (its own window, in the app launcher). The page follows the Omarchy theme
# when Settings → Appearance is "System".
set -euo pipefail
REPO="${TELEOPS_REPO:-emrgim/TeleOps}"
command -v omarchy-launch-webapp >/dev/null 2>&1 || echo "TeleOps: omarchy-launch-webapp not found, the browser will be used instead" >&2
SRC="${BASH_SOURCE[0]:-}"
if [ -n "$SRC" ] && [ -f "$SRC" ] && [ -f "$(dirname "$SRC")/linux.sh" ]; then
  exec bash "$(dirname "$SRC")/linux.sh" "$@"
fi
curl -fsSL "https://raw.githubusercontent.com/$REPO/main/install/linux.sh" | bash -s -- "$@"
