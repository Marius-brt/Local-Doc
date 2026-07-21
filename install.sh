#!/usr/bin/env bash
# Install the latest localdoc standalone binary for this machine.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Marius-brt/Local-Doc/main/install.sh | bash
#   LOCALDOC_VERSION=v0.1.0 ./install.sh
#   PREFIX=/usr/local/bin ./install.sh
#
# Env:
#   LOCALDOC_REPO      GitHub owner/repo (default: Marius-brt/Local-Doc)
#   LOCALDOC_VERSION   Release tag (default: latest)
#   LOCALDOC_LIBC      Force linux libc: gnu | musl
#   PREFIX             Install directory (default: ~/.local/bin)
#   LOCALDOC_BIN_NAME  Installed binary name (default: localdoc)
set -euo pipefail

REPO="${LOCALDOC_REPO:-Marius-brt/Local-Doc}"
PREFIX="${PREFIX:-${HOME}/.local/bin}"
BIN_NAME="${LOCALDOC_BIN_NAME:-localdoc}"
VERSION="${LOCALDOC_VERSION:-}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

detect_asset() {
  local os arch libc
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) die "unsupported CPU architecture: $(uname -m)" ;;
  esac

  case "$os" in
    darwin)
      printf 'localdoc-darwin-%s\n' "$arch"
      ;;
    linux)
      libc="gnu"
      if [ -n "${LOCALDOC_LIBC:-}" ]; then
        libc="${LOCALDOC_LIBC}"
      elif [ -f /etc/alpine-release ]; then
        libc="musl"
      elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
        libc="musl"
      fi
      if [ "$arch" != "x64" ]; then
        die "no published linux/${arch} build yet (available: linux-x64, linux-x64-musl)"
      fi
      if [ "$libc" = "musl" ]; then
        printf 'localdoc-linux-x64-musl\n'
      else
        printf 'localdoc-linux-x64\n'
      fi
      ;;
    mingw* | msys* | cygwin*)
      die "on Windows, download localdoc-windows-x64.exe from https://github.com/${REPO}/releases"
      ;;
    *)
      die "unsupported OS: $(uname -s)"
      ;;
  esac
}

parse_release() {
  # Prints: <tag> <download-url>
  local asset="$1"
  local api_url json tag url

  if [ -n "$VERSION" ]; then
    case "$VERSION" in
      v*) tag_query="$VERSION" ;;
      *) tag_query="v${VERSION}" ;;
    esac
    api_url="https://api.github.com/repos/${REPO}/releases/tags/${tag_query}"
  else
    api_url="https://api.github.com/repos/${REPO}/releases/latest"
  fi

  if [ -n "${GITHUB_TOKEN:-}" ]; then
    json="$(curl -fsSL \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "$api_url")" || die "failed to fetch ${api_url}"
  else
    json="$(curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      "$api_url")" || die "failed to fetch ${api_url} (create a GitHub release first)"
  fi

  if command -v jq >/dev/null 2>&1; then
    tag="$(printf '%s' "$json" | jq -r '.tag_name // empty')"
    url="$(printf '%s' "$json" | jq -r --arg n "$asset" '.assets[] | select(.name==$n) | .browser_download_url' | head -1)"
  elif command -v python3 >/dev/null 2>&1; then
    tag="$(LOCALDOC_JSON="$json" python3 -c 'import json,os; print(json.loads(os.environ["LOCALDOC_JSON"]).get("tag_name") or "")')"
    url="$(LOCALDOC_JSON="$json" LOCALDOC_ASSET="$asset" python3 -c '
import json, os
o = json.loads(os.environ["LOCALDOC_JSON"])
n = os.environ["LOCALDOC_ASSET"]
for a in o.get("assets") or []:
    if a.get("name") == n:
        print(a.get("browser_download_url") or "")
        break
')"
  else
    die "need jq or python3 to parse GitHub release metadata"
  fi

  if [ -z "${tag:-}" ] || [ "$tag" = "null" ]; then
    die "could not resolve release tag from GitHub API"
  fi
  if [ -z "${url:-}" ] || [ "$url" = "null" ]; then
    url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
  fi

  printf '%s %s\n' "$tag" "$url"
}

main() {
  need_cmd uname
  need_cmd curl
  need_cmd mktemp
  need_cmd install
  need_cmd tr

  bold "localdoc installer"
  local asset tag url tmp dest
  asset="$(detect_asset)"
  info "Platform asset: ${asset}"

  read -r tag url < <(parse_release "$asset")
  info "Release: ${tag}"
  info "URL: ${url}"

  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp" "$url" || die "download failed — is ${asset} attached to ${tag}?"

  mkdir -p "$PREFIX"
  dest="${PREFIX}/${BIN_NAME}"
  install -m 0755 "$tmp" "$dest"
  info "Installed ${dest}"

  case ":${PATH}:" in
    *":${PREFIX}:"*) ;;
    *)
      warn "${PREFIX} is not on PATH"
      printf 'Add to your shell profile:\n  export PATH="%s:\$PATH"\n' "$PREFIX"
      ;;
  esac

  if [ -x "$dest" ]; then
    info "Version check:"
    "$dest" --version 2>/dev/null || true
  fi

  bold "Done."
  printf 'Try: %s doctor\n' "$BIN_NAME"
  printf 'Repo: https://github.com/%s\n' "$REPO"
}

main "$@"
