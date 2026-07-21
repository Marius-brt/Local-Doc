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
#   LOCALDOC_SKIP_VERIFY  Set to 1 to skip SHA256 verification (not recommended)
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
      if [ "$arch" != "arm64" ]; then
        die "no published darwin/${arch} build (available: darwin-arm64); build from source on Intel Macs"
      fi
      printf 'localdoc-darwin-arm64\n'
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
  # Prints: <tag> <download-url> <checksums-url-or-empty>
  local asset="$1"
  local api_url json tag url sums_url

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
    sums_url="$(printf '%s' "$json" | jq -r '.assets[] | select(.name=="SHA256SUMS") | .browser_download_url' | head -1)"
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
    sums_url="$(LOCALDOC_JSON="$json" python3 -c '
import json, os
o = json.loads(os.environ["LOCALDOC_JSON"])
for a in o.get("assets") or []:
    if a.get("name") == "SHA256SUMS":
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
  if [ -z "${sums_url:-}" ] || [ "$sums_url" = "null" ]; then
    sums_url="https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS"
  fi

  printf '%s %s %s\n' "$tag" "$url" "$sums_url"
}

verify_sha256() {
  local file="$1"
  local sums_file="$2"
  local asset="$3"
  local expected actual

  expected="$(awk -v n="$asset" '$2 == n { print $1; exit }' "$sums_file")"
  if [ -z "$expected" ]; then
    die "SHA256SUMS has no entry for ${asset}"
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{ print $1 }')"
  else
    die "need sha256sum or shasum to verify download"
  fi

  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"
  fi
  info "Checksum OK (${actual})"
}

main() {
  need_cmd uname
  need_cmd curl
  need_cmd mktemp
  need_cmd install
  need_cmd tr

  bold "localdoc installer"
  local asset tag url sums_url tmp sums_tmp dest
  asset="$(detect_asset)"
  info "Platform asset: ${asset}"

  read -r tag url sums_url < <(parse_release "$asset")
  info "Release: ${tag}"
  info "URL: ${url}"

  tmp="$(mktemp)"
  sums_tmp="$(mktemp)"
  trap 'rm -f "$tmp" "$sums_tmp"' EXIT
  curl -fL --progress-bar -o "$tmp" "$url" || die "download failed — is ${asset} attached to ${tag}?"

  if [ "${LOCALDOC_SKIP_VERIFY:-}" = "1" ]; then
    warn "Skipping SHA256 verification (LOCALDOC_SKIP_VERIFY=1)"
  else
    info "Verifying SHA256…"
    curl -fsSL -o "$sums_tmp" "$sums_url" || die "failed to download SHA256SUMS from ${sums_url} (re-release with checksums, or set LOCALDOC_SKIP_VERIFY=1)"
    verify_sha256 "$tmp" "$sums_tmp" "$asset"
  fi

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
