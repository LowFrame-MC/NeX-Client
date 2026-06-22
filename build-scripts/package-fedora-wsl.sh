#!/usr/bin/env bash
set -euo pipefail

APP_NAME="NeX Client"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="/mnt/c/NeXClient-Dist"
MIN_NODE_MAJOR=22

log() {
  printf '[nex-fedora-build] %s\n' "$*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1
}

install_dnf_package() {
  local package_name="$1"
  if rpm -q "$package_name" >/dev/null 2>&1; then
    return
  fi

  log "Installing $package_name"
  sudo dnf install -y "$package_name"
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
  curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo bash -
  sudo dnf install -y nodejs
  hash -r

  node_major="$(current_node_major)"
  if [[ "$node_major" -lt "$MIN_NODE_MAJOR" ]] || ! need_command npm; then
    log "Node.js ${MIN_NODE_MAJOR}.x installation failed. Current node: $(node --version 2>/dev/null || echo missing)"
    exit 1
  fi

  log "Using Node $(node --version) and npm $(npm --version)"
}

install_system_dependencies() {
  log "Checking Fedora system packages"
  if ! need_command dnf; then
    log "dnf was not found. Run this script inside Fedora WSL."
    exit 1
  fi

  if ! sudo -v; then
    log "This script needs sudo to install Fedora packaging tools in WSL."
    log "Run it from a Fedora/WSL terminal so you can enter your password:"
    log "  cd \"$PROJECT_ROOT\" && bash build-scripts/package-fedora-wsl.sh"
    exit 1
  fi

  sudo dnf makecache -y
  install_dnf_package curl
  install_dnf_package ca-certificates
  install_node_runtime
  install_dnf_package rpm-build
  install_dnf_package rpmdevtools
  install_dnf_package libxcrypt-compat
  install_dnf_package ruby
  install_dnf_package ruby-devel
  install_dnf_package gcc
  install_dnf_package gcc-c++
  install_dnf_package make
  install_dnf_package libarchive

  if ! need_command fpm; then
    log "Installing fpm for RPM packaging"
    sudo gem install --no-document fpm
  fi
}

install_node_dependencies() {
  cd "$PROJECT_ROOT"

  if ! need_command npm; then
    log "npm is missing. Install Node.js ${MIN_NODE_MAJOR}+ in Fedora WSL before running this script."
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

run_build() {
  cd "$PROJECT_ROOT"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  export ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES=true

  log "Building Fedora RPM package"
  npx electron-builder --linux rpm --x64 --publish never
}

copy_artifacts() {
  log "Copying RPM artifacts to $TARGET_DIR"
  find "$PROJECT_ROOT/dist" -maxdepth 1 -type f -name "*.rpm" -print0 |
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
  run_build
  copy_artifacts
  log "Done. RPM artifacts are in $TARGET_DIR"
}

main "$@"
