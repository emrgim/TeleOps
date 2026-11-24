#!/usr/bin/env bash
# TeleOps for Linux — installs (or updates) TeleOps for the current user:
#
#   curl -fsSL https://raw.githubusercontent.com/emrgim/TeleOps/main/install/linux.sh | bash
#
# - downloads the latest release for this system (x64 or arm64), checks its SHA-256,
#   unpacks it in ~/.local/share/teleops/runtime/<version>  (Node included: nothing else to install)
# - runs it as a systemd user service (teleops.service): starts at login, restarts by itself;
#   later versions are installed by TeleOps itself (Settings → Updates)
# - adds "TeleOps" to the applications menu and opens it in the browser, already signed in
#
# The .deb / .rpm packages run this same script from /opt/teleops (command: teleops) with the
# runtime they carry, so nothing is downloaded.
#
# Options (environment): TELEOPS_PORT (default 8811), TELEOPS_ARCHIVE=<file> (install from a downloaded
# runtime archive), TELEOPS_SEED=<dir> (install from an unpacked runtime: the packages),
# TELEOPS_NO_BROWSER=1 (print the sign-in link instead), TELEOPS_NO_SERVICE=1 (no systemd service).
# Uninstall: bash linux.sh --uninstall   (add --purge to delete data too: bot tokens, messages)
set -euo pipefail

REPO="${TELEOPS_REPO:-emrgim/TeleOps}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/teleops"
RT="$DATA/runtime"
PORT="${TELEOPS_PORT:-8811}"
UNIT="teleops.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() {
  printf 'TeleOps: %s\n' "$*" >&2
  # started from the applications menu: nobody sees stderr
  if [ ! -t 2 ] && command -v notify-send >/dev/null 2>&1; then notify-send TeleOps "$*" || true; fi
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
healthy() { curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; }
# is version $1 newer than $2 (x.y.z)?
newer() {
  local IFS=. a b i
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    [ "${a[i]:-0}" -gt "${b[i]:-0}" ] && return 0
    [ "${a[i]:-0}" -lt "${b[i]:-0}" ] && return 1
  done
  return 1
}

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
  pid="$(cat "$DATA/service.lock" 2>/dev/null || true)"
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  rm -f "$UNIT_DIR/$UNIT" "$APPS/teleops.desktop" "$ICONS/teleops.png"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -rf "$RT"
  if [ "${2:-}" = "--purge" ]; then rm -rf "$DATA"; fi
  say "TeleOps removed for this user${2:+ (data deleted)}."
  exit 0
fi

need curl
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "this processor ($(uname -m)) is not supported: x64 or arm64 only" ;;
esac
if [ -z "${TELEOPS_NO_SERVICE:-}" ]; then
  need systemctl
  if systemctl --user is-active --quiet teleops.service 2>/dev/null; then
    die "TeleOps already runs here from a git install (teleops.service): stop it before installing the package"
  fi
fi

umask 077
mkdir -p "$RT"
chmod 700 "$DATA"
CUR="$(cat "$RT/current" 2>/dev/null || true)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FRESH=1
if [ -n "${TELEOPS_SEED:-}" ]; then
  # the runtime of an installed package: copied for this user unless the same or a newer version is here
  [ -f "$TELEOPS_SEED/VERSION" ] || die "$TELEOPS_SEED is not a TeleOps runtime"
  VER="$(cat "$TELEOPS_SEED/VERSION")"
  if [ -n "$CUR" ] && [ -x "$RT/$CUR/node/bin/node" ] && ! newer "$VER" "$CUR"; then
    FRESH=0
    VER="$CUR"
  fi
else
  need tar
  need sha256sum
  if [ -n "${TELEOPS_ARCHIVE:-}" ]; then
    NAME="$(basename "$TELEOPS_ARCHIVE")"
    VER="$(printf '%s' "$NAME" | sed -n 's/^teleops-\([0-9][0-9.]*\)-runtime-.*/\1/p')"
    [ -n "$VER" ] || die "$NAME is not a TeleOps runtime archive"
    cp "$TELEOPS_ARCHIVE" "$TMP/$NAME"
    if [ -f "$TELEOPS_ARCHIVE.sha256" ]; then cp "$TELEOPS_ARCHIVE.sha256" "$TMP/$NAME.sha256"; fi
  else
    # latest release: github.com/<repo>/releases/latest redirects to its tag
    TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
    TAG="${TAG##*/}"
    VER="${TAG#v}"
    [ -n "$VER" ] && [ "$VER" != latest ] || die "no release found on github.com/$REPO"
    NAME="teleops-$VER-runtime-linux-$ARCH.tar.gz"
    say "Downloading TeleOps $VER ($ARCH)…"
    curl -fL --retry 3 --progress-bar -o "$TMP/$NAME" "https://github.com/$REPO/releases/download/$TAG/$NAME" ||
      die "the package for linux-$ARCH of version $VER is not published yet: try again in a few minutes"
    curl -fsSL --retry 3 -o "$TMP/$NAME.sha256" "https://github.com/$REPO/releases/download/$TAG/$NAME.sha256"
  fi
  if [ -f "$TMP/$NAME.sha256" ]; then
    (cd "$TMP" && sha256sum -c --quiet "$NAME.sha256") || die "the download does not match its SHA-256"
  fi
fi

if [ "$FRESH" = 1 ]; then
  rm -rf "$RT/$VER.part"
  mkdir -p "$RT/$VER.part"
  if [ -n "${TELEOPS_SEED:-}" ]; then
    cp -a "$TELEOPS_SEED/." "$RT/$VER.part/"
    rm -f "$RT/$VER.part/VERSION"
  else
    tar -xzf "$TMP/$NAME" -C "$RT/$VER.part"
  fi
  [ -x "$RT/$VER.part/node/bin/node" ] && [ -f "$RT/$VER.part/app/dist/main.js" ] || die "the package is incomplete"
  if [ "$CUR" = "$VER" ] && [ -z "${TELEOPS_NO_SERVICE:-}" ]; then systemctl --user stop "$UNIT" 2>/dev/null || true; fi
  rm -rf "${RT:?}/$VER"
  mv "$RT/$VER.part" "$RT/$VER"
  if [ -n "$CUR" ] && [ "$CUR" != "$VER" ]; then printf '%s' "$CUR" >"$RT/previous"; fi
  printf '%s' "$VER" >"$RT/current.tmp" && mv "$RT/current.tmp" "$RT/current"
fi

# the service runs this wrapper: always the current version (the updater switches it)
cat >"$RT/run.sh" <<'EOF'
#!/usr/bin/env bash
RT="$(cd "$(dirname "$0")" && pwd)"
V="$(cat "$RT/current")"
export TELEOPS_RUNTIME_DIR="$RT" TELEOPS_SUPERVISED=1
exec "$RT/$V/node/bin/node" "$RT/$V/app/dist/main.js"
EOF
# "TeleOps" in the applications menu: opens the page already signed in
cat >"$RT/open.sh" <<EOF
#!/usr/bin/env bash
RT="\$(cd "\$(dirname "\$0")" && pwd)"
V="\$(cat "\$RT/current")"
for _ in \$(seq 1 60); do curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
URL="\$(TELEOPS_PORT=$PORT "\$RT/\$V/node/bin/node" "\$RT/\$V/app/dist/cli.js" login-link --local --minutes 2 | tail -1)"
if command -v omarchy-launch-webapp >/dev/null 2>&1; then exec omarchy-launch-webapp "\$URL"; fi
exec xdg-open "\$URL"
EOF
chmod 700 "$RT/run.sh" "$RT/open.sh"

# installed from a package: the menu entry and the icon come with it
if [ -z "${TELEOPS_SEED:-}" ]; then
  mkdir -p "$APPS" "$ICONS"
  cp "$RT/$VER/app/packaging/icons/TeleOps-256.png" "$ICONS/teleops.png"
  cat >"$APPS/teleops.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TeleOps
Comment=Telegram bots server: MCP, REST API, webhooks
Exec=$RT/open.sh
Icon=teleops
Terminal=false
Categories=Network;Chat;
StartupNotify=false
EOF
  chmod 644 "$APPS/teleops.desktop" "$ICONS/teleops.png"
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$APPS" >/dev/null 2>&1 || true; fi
fi

if [ -z "${TELEOPS_NO_SERVICE:-}" ]; then
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$UNIT.tmp" <<EOF
[Unit]
Description=TeleOps (Telegram bots server: MCP, REST API, webhooks)
After=network-online.target

[Service]
ExecStart=$RT/run.sh
Environment=TELEOPS_HOST=127.0.0.1
Environment=TELEOPS_PORT=$PORT
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
  if cmp -s "$UNIT_DIR/$UNIT.tmp" "$UNIT_DIR/$UNIT"; then
    rm -f "$UNIT_DIR/$UNIT.tmp"
  else
    mv "$UNIT_DIR/$UNIT.tmp" "$UNIT_DIR/$UNIT"
    FRESH=1
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1
  if [ "$FRESH" = 1 ]; then systemctl --user restart "$UNIT"; else systemctl --user start "$UNIT"; fi
elif [ "$FRESH" = 1 ] || ! healthy; then
  # no service: start it in the background for this session only
  pid="$(cat "$DATA/service.lock" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then sleep 2; fi
  (TELEOPS_HOST=127.0.0.1 TELEOPS_PORT="$PORT" nohup "$RT/run.sh" </dev/null >>"$DATA/run.log" 2>&1 &)
fi

for _ in $(seq 1 120); do
  healthy && break
  sleep 0.5
done
healthy || die "TeleOps did not start: journalctl --user -u $UNIT"
if [ "$FRESH" = 1 ]; then say "TeleOps $VER is running on http://127.0.0.1:$PORT"; fi
if [ -z "${TELEOPS_NO_BROWSER:-}" ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
  "$RT/open.sh" >/dev/null 2>&1 &
else
  echo "Sign in: $(TELEOPS_PORT=$PORT "$RT/$VER/node/bin/node" "$RT/$VER/app/dist/cli.js" login-link --local --minutes 30 | tail -1)"
fi
