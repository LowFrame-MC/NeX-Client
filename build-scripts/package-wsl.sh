#!/usr/bin/env bash
set -euo pipefail

APP_NAME="NeX Client"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="/mnt/c/NeXClient-Dist"
MODE="${1:-all}"
MIN_NODE_MAJOR=22

log() {
  printf '[nex-build] %s\n' "$*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1
}

install_apt_package() {
  local package_name="$1"
  if dpkg -s "$package_name" >/dev/null 2>&1; then
    return
  fi

  log "Installing $package_name"
  sudo apt-get install -y "$package_name"
}

install_wine() {
  if need_command wine; then
    return
  fi

  log "Installing Wine for Windows packaging"
  sudo dpkg --add-architecture i386 || true
  sudo apt-get update
  install_apt_package wine
  install_apt_package wine32
  install_apt_package wine64
}

current_node_major() {
  if ! need_command node; then
    printf '0'
    return
  fi

  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0'
}

install_node_runtime() {
  local node_major
  node_major="$(current_node_major)"

  if [[ "$node_major" -ge "$MIN_NODE_MAJOR" ]] && need_command npm; then
    log "Using Node $(node --version) and npm $(npm --version)"
    return
  fi

  log "Installing Node.js ${MIN_NODE_MAJOR}.x for Electron Builder"
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
  hash -r

  node_major="$(current_node_major)"
  if [[ "$node_major" -lt "$MIN_NODE_MAJOR" ]] || ! need_command npm; then
    log "Node.js ${MIN_NODE_MAJOR}.x installation failed. Current node: $(node --version 2>/dev/null || echo missing)"
    exit 1
  fi

  log "Using Node $(node --version) and npm $(npm --version)"
}

install_system_dependencies() {
  log "Checking system packages"
  if ! sudo -v; then
    log "This script needs sudo to install Linux packaging tools in WSL."
    log "Run it from an Ubuntu/WSL terminal so you can enter your password:"
    log "  cd \"$PROJECT_ROOT\" && bash build-scripts/package-wsl.sh ${MODE}"
    exit 1
  fi

  sudo apt-get update
  install_apt_package curl
  install_apt_package ca-certificates
  install_node_runtime
  install_apt_package rpm
  install_apt_package fakeroot
  install_apt_package dpkg
  install_apt_package ruby
  install_apt_package ruby-dev
  install_apt_package build-essential
  if ! need_command fpm; then
    log "Installing fpm for Debian packaging"
    sudo gem install --no-document fpm
  fi
  install_wine
}

install_node_dependencies() {
  cd "$PROJECT_ROOT"

  if ! need_command npm; then
    log "npm is missing. Install Node.js ${MIN_NODE_MAJOR}+ in WSL before running this script."
    exit 1
  fi

  log "Installing npm dependencies"
  npm install

  if ! npx --yes electron-builder --version >/dev/null 2>&1; then
    log "Installing electron-builder"
    npm install --save-dev electron-builder
  fi
}

prepare_output() {
  mkdir -p "$TARGET_DIR"
}

run_builds() {
  cd "$PROJECT_ROOT"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  export ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES=true

  if [[ "$MODE" != "--deb-only" ]]; then
    log "Building Windows EXE installer"
    npx electron-builder --win nsis --x64 --publish never

    log "Building Windows MSI installer"
    npx electron-builder --win msi --x64 --publish never
  fi

  log "Building Debian package"
  npx electron-builder --linux deb --x64 --publish never
}

copy_artifacts() {
  log "Copying artifacts to $TARGET_DIR"
  find "$PROJECT_ROOT/dist" -maxdepth 1 -type f \( -name "*.exe" -o -name "*.msi" -o -name "*.deb" \) -print0 |
    while IFS= read -r -d '' artifact; do
      cp -f "$artifact" "$TARGET_DIR/"
      log "Copied $(basename "$artifact")"
    done
}

main() {
  log "Packaging $APP_NAME from $PROJECT_ROOT"
  install_system_dependencies
  install_node_dependencies
  prepare_output
  run_builds
  copy_artifacts
  log "Done. Artifacts are in $TARGET_DIR"
}

main "$@"
