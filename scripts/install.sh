#!/bin/sh

set -eu

MINIMUM_NODE_MAJOR=24
DEFAULT_BIN_DIR="${HOME}/.local/bin"
BIN_DIR="${ALFACODE_BIN_DIR:-$DEFAULT_BIN_DIR}"
FORCE=0
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [options]

Build AlfaCode and install its launcher.

Options:
  --bin-dir <path>  Install the launcher in a custom directory
  --force           Replace an existing launcher not managed by AlfaCode
  --skip-build      Skip dependency installation and build (development only)
  -h, --help        Show this help
EOF
}

fail() {
  printf 'AlfaCode installer: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      [ "$#" -ge 2 ] || fail "--bin-dir requires a path"
      BIN_DIR=$2
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

command -v node >/dev/null 2>&1 || fail "Node.js ${MINIMUM_NODE_MAJOR}+ is required"

NODE_VERSION=$(node --version 2>/dev/null || true)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
[ -n "$NODE_MAJOR" ] || fail "unable to parse Node.js version: ${NODE_VERSION:-unknown}"
[ "$NODE_MAJOR" -ge "$MINIMUM_NODE_MAJOR" ] || fail "Node.js ${MINIMUM_NODE_MAJOR}+ is required; found ${NODE_VERSION}"

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

if [ "$SKIP_BUILD" -eq 0 ]; then
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required; install it with: corepack enable pnpm"
  printf 'Installing locked dependencies...\n'
  (cd "$PROJECT_DIR" && pnpm install --frozen-lockfile)
  printf 'Building AlfaCode...\n'
  (cd "$PROJECT_DIR" && pnpm build)
fi

ENTRYPOINT="$PROJECT_DIR/dist/cli.js"
[ -f "$ENTRYPOINT" ] || fail "build output is missing: $ENTRYPOINT"

case "$BIN_DIR" in
  /*) ;;
  *) fail "the launcher directory must be an absolute path" ;;
esac

umask 077
mkdir -p "$BIN_DIR"
TARGET="$BIN_DIR/alfacode"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  [ ! -d "$TARGET" ] || fail "$TARGET resolves to a directory; choose another --bin-dir"
  if [ ! -f "$TARGET" ] && [ ! -L "$TARGET" ]; then
    fail "$TARGET is not a regular file or symbolic link; choose another --bin-dir"
  fi
  if [ ! -f "$TARGET" ] || ! grep -q '^# Managed by AlfaCode installer$' "$TARGET" 2>/dev/null; then
    [ "$FORCE" -eq 1 ] || fail "$TARGET already exists and is not managed by AlfaCode; use --force to replace it"
  fi
fi

TEMP_FILE=$(mktemp "$BIN_DIR/.alfacode.XXXXXX")
cleanup() {
  rm -f "$TEMP_FILE"
}
trap cleanup EXIT HUP INT TERM

QUOTED_ENTRYPOINT=$(printf '%s' "$ENTRYPOINT" | sed "s/'/'\\\\''/g")
{
  printf '%s\n' '#!/bin/sh'
  printf '%s\n' '# Managed by AlfaCode installer'
  printf "exec node '%s' \"\$@\"\n" "$QUOTED_ENTRYPOINT"
} > "$TEMP_FILE"
chmod 755 "$TEMP_FILE"
mv -f "$TEMP_FILE" "$TARGET"
trap - EXIT HUP INT TERM

printf '\nAlfaCode installed: %s\n' "$TARGET"
case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    printf 'Run: alfacode\n'
    ;;
  *)
    printf 'Add this directory to PATH, then run alfacode:\n'
    # The printed command must preserve $PATH for the user's shell.
    # shellcheck disable=SC2016
    printf '  export PATH="%s:%s"\n' "$BIN_DIR" '$PATH'
    ;;
esac
