#!/usr/bin/env bash
set -euo pipefail

APP_NAME="NeX Client"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="/mnt/c/NeXClient-Dist"

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

install_system_dependencies() {
  log "Checking system packages"
  sudo apt-get update
  install_apt_package curl
  install_apt_package ca-certificates
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
    log "npm is missing. Install Node.js 20+ in WSL before running this script."
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
  rm -rf "$PROJECT_ROOT/dist"
}

run_builds() {
  cd "$PROJECT_ROOT"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  export ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES=true

  log "Building Windows EXE installer"
  npx electron-builder --win nsis --x64 --publish never

  log "Building Windows MSI installer"
  npx electron-builder --win msi --x64 --publish never

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
