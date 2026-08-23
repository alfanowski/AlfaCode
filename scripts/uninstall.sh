#!/bin/sh

set -eu

DEFAULT_BIN_DIR="${HOME}/.local/bin"
BIN_DIR="${ALFACODE_BIN_DIR:-$DEFAULT_BIN_DIR}"

usage() {
  cat <<'EOF'
Usage: ./scripts/uninstall.sh [--bin-dir <path>]

Remove the launcher created by the AlfaCode installer. Configuration, usage
history, sessions, and Keychain credentials are intentionally preserved.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      [ "$#" -ge 2 ] || { printf '%s\n' 'Missing value for --bin-dir' >&2; exit 1; }
      BIN_DIR=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

case "$BIN_DIR" in
  /*) ;;
  *) printf '%s\n' 'The launcher directory must be an absolute path' >&2; exit 1 ;;
esac

TARGET="$BIN_DIR/alfacode"
if [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  printf 'No AlfaCode launcher found at %s\n' "$TARGET"
  exit 0
fi

if [ ! -f "$TARGET" ] || ! grep -q '^# Managed by AlfaCode installer$' "$TARGET" 2>/dev/null; then
  printf 'Refusing to remove an unmanaged command at %s\n' "$TARGET" >&2
  exit 1
fi

rm "$TARGET"
printf 'Removed AlfaCode launcher: %s\n' "$TARGET"
printf '%s\n' 'Configuration and Keychain credentials were preserved.'
