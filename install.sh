#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pilot — Linux install script
#
# One-liner:  curl -fsSL https://pilot.remarkablenerds.com/install.sh | bash
#
# Installs Node.js ≥ 20, pnpm, Tailscale, system dependencies, clones the
# Pilot repo into ~/.local/share/pilot, builds the CLI daemon, registers a
# systemd user unit, and starts the daemon.
#
# Configurable via env vars (all optional):
#   PILOT_HOME        Install directory  (default: $HOME/.local/share/pilot)
#   PILOT_REPO_URL    Git repo to clone  (default: https://github.com/jordansoper/Pilot.git)
#   PILOT_PORT        Daemon listen port (default: 7117)
#   PILOT_BIND        Bind address        (default: 0.0.0.0)
#   PILOT_NAME        Machine name        (default: hostname)
#   PILOT_SKIP_DEPS   Skip system-dep install if set to 1
#   PILOT_SKIP_NODE   Skip Node.js check  if set to 1
#   PILOT_SKIP_TS     Skip Tailscale check if set to 1
#   PILOT_NO_START    Don't start daemon  if set to 1
#   PILOT_NO_SYSTEMD  Don't install unit  if set to 1
# ---------------------------------------------------------------------------
set -euo pipefail

# Never let git block on an interactive credential prompt — this script is
# meant to run non-interactively (curl | bash). Without this, a private or
# unreachable PILOT_REPO_URL hangs the installer forever instead of failing.
export GIT_TERMINAL_PROMPT=0

# ── helpers ────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()     { echo -e "${BLUE}[pilot]${NC} $1"; }
ok()      { echo -e "${GREEN}[pilot]${NC} ✓ $1"; }
warn()    { echo -e "${YELLOW}[pilot]${NC} ⚠ $1"; }
err()     { echo -e "${RED}[pilot]${NC} ✗ $1"; }
section() { echo -e "\n${BOLD}${BLUE}▶${NC} ${BOLD}$1${NC}"; }

die() {
  err "$1"
  exit 1
}

has_cmd() { command -v "$1" &>/dev/null; }

# ── config ─────────────────────────────────────────────────────────────────

PILOT_HOME="${PILOT_HOME:-$HOME/.local/share/pilot}"
PILOT_REPO_URL="${PILOT_REPO_URL:-https://github.com/jordansoper/Pilot.git}"
PILOT_PORT="${PILOT_PORT:-7117}"
PILOT_BIND="${PILOT_BIND:-0.0.0.0}"
PILOT_NAME="${PILOT_NAME:-$(hostname)}"
PILOT_SKIP_DEPS="${PILOT_SKIP_DEPS:-0}"
PILOT_SKIP_NODE="${PILOT_SKIP_NODE:-0}"
PILOT_SKIP_TS="${PILOT_SKIP_TS:-0}"
PILOT_NO_START="${PILOT_NO_START:-0}"
PILOT_NO_SYSTEMD="${PILOT_NO_SYSTEMD:-0}"

# Distro detection globals (populated by detect_distro)
DISTRO_ID=""
DISTRO_LIKE=""
PKG_MANAGER=""
IS_MUSL=0

# ── distro detection ───────────────────────────────────────────────────────

detect_distro() {
  section "Detecting Linux distribution"

  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    # DISTRO_LIKE is space-separated, e.g. "ubuntu debian"
    DISTRO_LIKE="${ID_LIKE:-}"
  elif [ -f /etc/arch-release ]; then
    DISTRO_ID="arch"
  else
    DISTRO_ID="unknown"
  fi

  # Detect musl (Alpine, Void musl, etc.)
  if ldd /bin/sh 2>/dev/null | grep -q musl; then
    IS_MUSL=1
  fi

  # Map to package manager
  case "$DISTRO_ID" in
    ubuntu|debian|pop|linuxmint|elementary|zorin|kali|raspbian)
      PKG_MANAGER="apt"
      ;;
    fedora|rhel|centos|rocky|almalinux|ol|amzn)
      PKG_MANAGER="dnf"
      ;;
    arch|manjaro|endeavouros|garuda|arcolinux)
      PKG_MANAGER="pacman"
      ;;
    opensuse*|sles)
      PKG_MANAGER="zypper"
      ;;
    alpine)
      PKG_MANAGER="apk"
      ;;
    *)
      # Try fallback from ID_LIKE
      for like in $DISTRO_LIKE; do
        case "$like" in
          debian|ubuntu) PKG_MANAGER="apt"; break ;;
          rhel|fedora)   PKG_MANAGER="dnf"; break ;;
          arch)          PKG_MANAGER="pacman"; break ;;
          suse)          PKG_MANAGER="zypper"; break ;;
        esac
      done
      ;;
  esac

  if [ -z "$PKG_MANAGER" ]; then
    warn "Could not detect package manager for distro '$DISTRO_ID'. Will try to proceed, but you may need to install dependencies manually."
    PKG_MANAGER="unknown"
  else
    ok "Detected: $DISTRO_ID (package manager: $PKG_MANAGER)$([ "$IS_MUSL" = 1 ] && echo ', musl libc')"
  fi
}

# ── system dependencies ────────────────────────────────────────────────────

needs_sudo() {
  # Return 0 if the pkg manager requires sudo (not running as root and pkg
  # manager isn't apk which can work without sudo in some setups).
  if [ "$(id -u)" -eq 0 ]; then
    return 1  # already root
  fi
  return 0
}

run_pkg_install() {
  local desc="$1"; shift
  log "Installing $desc..."
  if needs_sudo; then
    if ! has_cmd sudo; then
      die "This needs root (running as non-root, and 'sudo' isn't installed). Re-run as root or install sudo first."
    fi
    sudo "$@"
  else
    "$@"
  fi
}

install_system_deps() {
  if [ "$PILOT_SKIP_DEPS" = "1" ]; then
    warn "Skipping system dependency installation (PILOT_SKIP_DEPS=1)"
    return
  fi
  section "Installing system dependencies"

  case "$PKG_MANAGER" in
    apt)
      # Only update if lists are older than 1 day (idempotent re-runs)
      local apt_age=0
      if [ -d /var/lib/apt/lists ]; then
        apt_age=$(find /var/lib/apt/lists -maxdepth 1 -name '*_Packages' -mmin +1440 2>/dev/null | wc -l)
        if [ "$apt_age" -gt 0 ] || [ ! -f /var/lib/apt/lists/lock ]; then
          run_pkg_install "apt update" apt-get update -qq
        fi
      else
        run_pkg_install "apt update" apt-get update -qq
      fi
      # Try with libasound2t64 first (Ubuntu 24.04+), silently fall back to libasound2
      if ! run_pkg_install "build tools & Electron deps (apt)" \
        apt-get install -y -qq \
          build-essential python3 git curl \
          libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
          xdg-utils libgbm1 libasound2t64 2>/dev/null; then
        run_pkg_install "build tools & Electron deps (apt, fallback)" \
          apt-get install -y -qq \
            build-essential python3 git curl \
            libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
            xdg-utils libgbm1 libasound2
      fi
      ;;
    dnf)
      run_pkg_install "build tools & Electron deps (dnf)" \
        dnf install -y \
          gcc-c++ python3 git curl \
          gtk3 libnotify nss libXScrnSaver libXtst \
          xdg-utils mesa-libgbm alsa-lib
      ;;
    pacman)
      run_pkg_install "build tools & Electron deps (pacman)" \
        pacman -Syu --noconfirm --needed \
          base-devel python git curl \
          gtk3 libnotify nss libxss libxtst \
          xdg-utils mesa alsa-lib
      ;;
    zypper)
      run_pkg_install "build tools & Electron deps (zypper)" \
        zypper install -y \
          gcc-c++ python3 git curl \
          gtk3 libnotify4 mozilla-nss libXss1 libXtst6 \
          xdg-utils libgbm1 alsa
      ;;
    apk)
      # Alpine — need build tools for node-pty (no musl prebuild)
      run_pkg_install "build tools & Electron deps (apk)" \
        apk add --no-cache \
          build-base python3 git curl \
          gtk+3.0 libnotify nss libxscrnsaver libxtst \
          xdg-utils mesa-gbm alsa-lib
      ;;
    unknown)
      warn "Unknown package manager. Install the following manually:"
      warn "  build-essential / gcc-c++ / base-devel"
      warn "  python3  git  curl"
      warn "  gtk3  libnotify  nss  libxss  libxtst  xdg-utils  libgbm"
      ;;
  esac

  ok "System dependencies installed"
}

# ── Node.js ────────────────────────────────────────────────────────────────

install_nodejs() {
  if [ "$PILOT_SKIP_NODE" = "1" ]; then
    warn "Skipping Node.js check (PILOT_SKIP_NODE=1)"
    return
  fi

  if has_cmd node; then
    local node_ver
    node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$node_ver" -ge 20 ]; then
      ok "Node.js $(node -v) already installed (≥ 20)"
      return
    fi
    warn "Node.js $(node -v) found but < 20 — upgrading"
  fi

  section "Installing Node.js ≥ 20"

  case "$PKG_MANAGER" in
    apt)
      # NodeSource setup for Debian/Ubuntu
      log "Adding NodeSource repository (Node.js 20.x)..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      run_pkg_install "Node.js 20.x" apt-get install -y -qq nodejs
      ;;
    dnf)
      # NodeSource setup for Fedora/RHEL
      log "Adding NodeSource repository (Node.js 20.x)..."
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
      run_pkg_install "Node.js 20.x" dnf install -y nodejs
      ;;
    pacman)
      run_pkg_install "Node.js (pacman)" pacman -Syu --noconfirm --needed nodejs npm
      ;;
    zypper)
      log "Adding NodeSource repository (Node.js 20.x)..."
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
      run_pkg_install "Node.js 20.x" zypper install -y nodejs
      ;;
    apk)
      run_pkg_install "Node.js (apk)" apk add --no-cache nodejs npm
      ;;
    *)
      # Universal fallback: nvm
      warn "No package-manager path for Node.js — installing via nvm"
      install_nodejs_nvm
      return
      ;;
  esac

  if ! has_cmd node; then
    warn "Package manager install failed — falling back to nvm"
    install_nodejs_nvm
  fi

  ok "Node.js $(node -v) installed"
}

install_nodejs_nvm() {
  log "Installing Node.js via nvm..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
  nvm alias default 20
}

# ── pnpm ───────────────────────────────────────────────────────────────────

install_pnpm() {
  section "Checking pnpm"

  if has_cmd pnpm; then
    local pnpm_ver
    pnpm_ver=$(pnpm -v | cut -d. -f1)
    if [ "$pnpm_ver" -ge 9 ]; then
      ok "pnpm $(pnpm -v) already installed (≥ 9)"
      return
    fi
    warn "pnpm $(pnpm -v) found but < 9 — upgrading"
  fi

  log "Installing pnpm..."
  # Use npm to install pnpm globally; corepack enable as fallback
  if has_cmd npm; then
    npm install -g pnpm@9
  elif has_cmd corepack; then
    corepack enable
    corepack prepare pnpm@9 --activate
  else
    # Direct install script
    curl -fsSL https://get.pnpm.io/install.sh | sh -
  fi

  # Ensure pnpm is on PATH for this session
  export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  case ":$PATH:" in
    *:"$PNPM_HOME":*) ;;
    *) export PATH="$PNPM_HOME:$PATH" ;;
  esac

  if ! has_cmd pnpm; then
    die "pnpm installation failed. Install it manually: npm install -g pnpm@9"
  fi
  ok "pnpm $(pnpm -v) installed"
}

# ── Tailscale ──────────────────────────────────────────────────────────────

install_tailscale() {
  if [ "$PILOT_SKIP_TS" = "1" ]; then
    warn "Skipping Tailscale check (PILOT_SKIP_TS=1)"
    return
  fi

  section "Checking Tailscale"

  if has_cmd tailscale; then
    ok "Tailscale $(tailscale version 2>/dev/null | head -1) already installed"
    # Check if authenticated
    if tailscale status &>/dev/null; then
      ok "Tailscale is up and authenticated"
    else
      warn "Tailscale installed but not running or not authenticated."
      warn "Run: sudo tailscale up"
      warn "Pilot will work on LAN without Tailscale, but remote access needs it."
    fi
    return
  fi

  warn "Tailscale not found. It's recommended for remote access (Pilot works on LAN without it)."
  log "Installing Tailscale via official script..."
  curl -fsSL https://tailscale.com/install.sh | sh

  if has_cmd tailscale; then
    ok "Tailscale installed. Start it with: sudo tailscale up"
  else
    warn "Tailscale installation may have failed. You can install it later from https://tailscale.com/download"
  fi
}

# ── Pilot ──────────────────────────────────────────────────────────────────

install_pilot() {
  section "Installing Pilot"

  if [ -d "$PILOT_HOME/.git" ]; then
    log "Existing Pilot installation found at $PILOT_HOME"
    log "Pulling latest changes..."
    if git -C "$PILOT_HOME" pull --ff-only; then
      ok "Pilot updated"
    else
      err "Could not pull latest changes — you may be running stale code."
      err ""
      err "This happens when the checkout has local changes or a diverged history."
      err "To force a clean update: rm -rf $PILOT_HOME && re-run this script."
      err ""
      warn "Continuing with the existing checkout (may not be up to date)."
    fi
  elif [ -d "$PILOT_HOME" ] && [ -n "$(ls -A "$PILOT_HOME" 2>/dev/null)" ]; then
    # PILOT_HOME exists with content but isn't a git checkout — e.g. deployed
    # by rsync/scp instead of this script. `git clone` refuses non-empty
    # directories, so don't even try; just build what's already there.
    warn "$PILOT_HOME exists and is non-empty but isn't a git repo — skipping clone, building in place"
  else
    log "Cloning Pilot into $PILOT_HOME..."
    mkdir -p "$(dirname "$PILOT_HOME")"
    if ! git clone "$PILOT_REPO_URL" "$PILOT_HOME"; then
      die "Failed to clone $PILOT_REPO_URL into $PILOT_HOME. Check that the repo is accessible."
    fi
    ok "Pilot cloned"
  fi
}

build_pilot() {
  section "Building Pilot CLI"

  cd "$PILOT_HOME"

  # Scoped to @pilot/cli and its dependencies (pulls in @pilot/shared too).
  # A plain workspace-wide `pnpm install` also installs packages/desktop's
  # devDependencies (electron, electron-builder) purely to run this daemon,
  # which drags in native rebuilds (node-pty for Electron's ABI, plus the
  # incidental dtrace-provider gyp step) that can hang or fail on a server
  # without a full C++ toolchain — and none of it is needed here.
  #
  # node-linker is also forced to "isolated" here, overriding the repo's
  # .npmrc (which sets "hoisted" for Expo/React Native's benefit) — hoisted
  # mode flattens the whole workspace into one node_modules regardless of
  # --filter, so without this override the desktop deps get pulled in anyway.
  log "Installing dependencies (pnpm install)..."
  pnpm install --frozen-lockfile --filter "@pilot/cli..." --config.node-linker=isolated 2>/dev/null \
    || pnpm install --filter "@pilot/cli..." --config.node-linker=isolated

  # The postinstall script (scripts/fix-node-pty-perms.mjs) runs automatically
  # after pnpm install and fixes the spawn-helper +x bit dropped by pnpm's store.
  # Verify it ran:
  log "Verifying node-pty spawn-helper permissions..."
  local spawn_helper
  spawn_helper=$(find "$PILOT_HOME/node_modules" -maxdepth 8 -name spawn-helper -type f 2>/dev/null | head -1)
  if [ -n "$spawn_helper" ] && [ ! -x "$spawn_helper" ]; then
    warn "spawn-helper missing +x — running fix script manually"
    node "$PILOT_HOME/scripts/fix-node-pty-perms.mjs"
  fi

  # @pilot/shared is already built by its "prepare" script during
  # pnpm install above — no need to build it again here.

  log "Building CLI package..."
  pnpm --filter @pilot/cli build

  # Verify the built output exists
  if [ ! -f "$PILOT_HOME/packages/cli/dist/index.js" ]; then
    die "Build failed — $PILOT_HOME/packages/cli/dist/index.js not found"
  fi

  ok "Pilot CLI built successfully"
}

# ── systemd user unit ──────────────────────────────────────────────────────

SYSTEMD_UNIT_DIR="$HOME/.config/systemd/user"
SYSTEMD_UNIT_FILE="$SYSTEMD_UNIT_DIR/pilot-cli.service"

generate_systemd_unit() {
  # Discover absolute path to node at generation time (after install_nodejs has
  # run) so the systemd unit can invoke node directly — no shell wrapper needed.
  local node_bin
  node_bin="$(which node 2>/dev/null || echo node)"

  cat <<EOF
# Pilot CLI daemon — runs as a user service (no root needed).
# Managed by the Pilot install script (install.sh).
# Control: systemctl --user {enable,disable,start,stop,restart} pilot-cli

[Unit]
Description=Pilot CLI daemon
Documentation=https://github.com/jordansoper/Pilot
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PILOT_HOME
ExecStart=$node_bin $PILOT_HOME/packages/cli/dist/index.js --bind $PILOT_BIND --port $PILOT_PORT --name $PILOT_NAME --no-qr
Restart=on-failure
RestartSec=5

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pilot-cli

# Security hardening (still allows network + PTY)
NoNewPrivileges=yes
PrivateTmp=no
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

[Install]
WantedBy=default.target
EOF
}

# Check whether systemd --user actually works (binary may exist but the user
# session bus might not — common in Docker, WSL, and chroot environments).
has_systemd_user() {
  has_cmd systemctl && systemctl --user show &>/dev/null
}

install_systemd_unit() {
  if [ "$PILOT_NO_SYSTEMD" = "1" ]; then
    warn "Skipping systemd unit (PILOT_NO_SYSTEMD=1)"
    return
  fi

  section "Installing systemd user unit"

  if ! has_systemd_user; then
    warn "systemd user bus not available — skipping service unit installation."
    warn ""
    warn "(This is normal in Docker, WSL, or chroot environments.)"
    warn ""
    warn "To run the Pilot daemon manually:"
    warn "  cd $PILOT_HOME"
    warn "  node packages/cli/dist/index.js --bind $PILOT_BIND --port $PILOT_PORT"
    warn ""
    warn "To have it start at login, add the command above to your shell profile"
    warn "or init system (OpenRC, runit, etc.)."
    return
  fi

  mkdir -p "$SYSTEMD_UNIT_DIR"
  generate_systemd_unit > "$SYSTEMD_UNIT_FILE"
  ok "Unit file written to $SYSTEMD_UNIT_FILE"

  systemctl --user daemon-reload

  # Enable the unit (start at login)
  systemctl --user enable pilot-cli.service
  ok "systemd user unit enabled (starts at login)"

  # Without lingering, the user's systemd instance (and everything in it,
  # including this unit) is killed the moment the last session for this user
  # ends — e.g. your SSH connection closes. That defeats the entire point of
  # a background daemon. Enable it so the unit survives logout/reboot.
  if has_cmd loginctl; then
    if loginctl enable-linger "$(whoami)" 2>/dev/null; then
      ok "Lingering enabled for $(whoami) — daemon survives logout"
    else
      warn "Could not enable lingering (needs root/polkit). Without it, the daemon"
      warn "stops when your login session ends. Run manually: loginctl enable-linger $(whoami)"
    fi
  fi
}

start_daemon() {
  if [ "$PILOT_NO_START" = "1" ]; then
    warn "Skipping daemon start (PILOT_NO_START=1)"
    return
  fi

  section "Starting Pilot daemon"

  if ! has_systemd_user; then
    warn "systemd user bus not available — start the daemon manually:"
    warn "  cd $PILOT_HOME"
    warn "  node packages/cli/dist/index.js --bind $PILOT_BIND --port $PILOT_PORT &"
    warn "  disown"
    return
  fi

  # Check if port is already in use
  if ss -tlnp 2>/dev/null | grep -q ":$PILOT_PORT " || \
     netstat -tlnp 2>/dev/null | grep -q ":$PILOT_PORT "; then
    warn "Port $PILOT_PORT is already in use. Checking if it's a Pilot daemon..."
    if systemctl --user is-active --quiet pilot-cli.service 2>/dev/null; then
      ok "Pilot daemon is already running via systemd"
      return
    fi
    warn "Another process is using port $PILOT_PORT. The daemon may fail to start."
    warn "Stop the other process or set PILOT_PORT to a different port."
  fi

  systemctl --user start pilot-cli.service

  # Poll for up to 10 seconds until the unit is active
  local attempts=0
  while [ $attempts -lt 10 ]; do
    if systemctl --user is-active --quiet pilot-cli.service 2>/dev/null; then
      ok "Pilot daemon started successfully"
      return
    fi
    # If the unit failed immediately, don't keep waiting
    if systemctl --user is-failed --quiet pilot-cli.service 2>/dev/null; then
      break
    fi
    sleep 1
    attempts=$((attempts + 1))
  done

  warn "Daemon may have failed to start. Check logs:"
  warn "  journalctl --user -u pilot-cli.service -n 30"
  warn ""
  warn "Try starting manually to debug:"
  warn "  cd $PILOT_HOME && node packages/cli/dist/index.js --bind $PILOT_BIND --port $PILOT_PORT"
}

# ── success ────────────────────────────────────────────────────────────────

print_success() {
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║                     Pilot is installed!                     ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${BOLD}Install location:${NC} $PILOT_HOME"
  echo -e "  ${BOLD}Daemon port:${NC}      $PILOT_PORT"
  echo -e "  ${BOLD}Bind address:${NC}     $PILOT_BIND"
  echo ""
  echo -e "  ${BOLD}Pair your phone:${NC}"
  echo "  1. Ensure your phone and this machine are on the same Wi-Fi"
  echo "     (or both connected to Tailscale)."
  echo "  2. Open the Pilot app on your phone."
  echo "  3. Tap '+' to add a machine, then scan the QR code displayed at:"
  echo -e "     ${BLUE}http://localhost:$PILOT_PORT/${NC}"
  echo ""
  echo -e "  ${BOLD}Manage the daemon:${NC}"
  if has_systemd_user; then
    echo "    systemctl --user status   pilot-cli   # check status"
    echo "    systemctl --user stop     pilot-cli   # stop daemon"
    echo "    systemctl --user restart  pilot-cli   # restart daemon"
    echo "    journalctl --user -u pilot-cli -f     # follow logs"
  else
    echo "    cd $PILOT_HOME"
    echo "    node packages/cli/dist/index.js --bind $PILOT_BIND --port $PILOT_PORT"
  fi
  echo ""
  echo -e "  ${BOLD}Update Pilot:${NC}"
  echo "    cd $PILOT_HOME && git pull && pnpm install --filter '@pilot/cli...' --config.node-linker=isolated && pnpm --filter @pilot/shared build && pnpm --filter @pilot/cli build"
  if has_systemd_user; then
    echo "    systemctl --user restart pilot-cli"
  fi
  echo ""
}

# ── main ───────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}${BLUE}"
  echo "  ╭──────────────────────────────────────────╮"
  echo "  │  Pilot — Linux Installer                 │"
  echo "  │  Remote CLI connector for dev machines   │"
  echo "  ╰──────────────────────────────────────────╯"
  echo -e "${NC}"

  # Warn if the repo is private and no credentials are configured.
  # Use a low-speed timeout so a hung network doesn't block the installer
  # forever before install_pilot()'s own clone attempt even starts.
  if [[ "$PILOT_REPO_URL" == https://github.com/* ]]; then
    if ! git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 \
           ls-remote "$PILOT_REPO_URL" &>/dev/null; then
      warn "Cannot reach $PILOT_REPO_URL anonymously (or it timed out)."
      warn "If the repo is private, set PILOT_REPO_URL to a git+ssh URL or"
      warn "provide a token: https://<token>@github.com/user/repo.git"
      warn "Continuing anyway — the clone step may prompt for credentials."
    fi
  fi

  detect_distro
  install_system_deps
  install_nodejs
  install_pnpm
  install_tailscale
  install_pilot
  build_pilot
  install_systemd_unit
  start_daemon
  print_success
}

main "$@"
