#!/bin/sh
# Runs one of the operator processes, `crank` or `keeper`, after checking
# everything it needs is in place, so a missing mount stops here with a
# message that says what to mount, and never as a key made on the spot: the
# tools make a key file they cannot find.
#
# The settings the image can know are defaults in the Dockerfile; every one can
# be overridden with an environment variable. Nothing is echoed that could hold
# a secret: not the Solana RPC address, which carries a provider's API key, and
# not the ping address.
set -eu

fail() {
  echo "$1 Nothing was started." >&2
  exit "${2:-78}"
}

tool="${1:-}"
case "$tool" in
  crank | keeper) ;;
  *) fail "This image runs one process, named by its command, and '${tool}' is not one of them: run it with 'crank' or 'keeper'." 64 ;;
esac
[ "$#" -eq 1 ] || fail "The ${tool} takes no arguments: it is set by environment variables." 64

[ -n "${MAINNET_PROGRAM_ID:-}" ] ||
  fail "MAINNET_PROGRAM_ID is not set. Set it to the program id this ${tool} works for: it is sending to mainnet, and it will not without the id named."
[ -n "${ROLLUP_URL:-}" ] ||
  fail "ROLLUP_URL is not set. Set it to the address of the rollup the exchange is delegated to."
[ -n "${VALIDATOR:-}" ] ||
  fail "VALIDATOR is not set. Set it to the public key of the validator that runs that rollup."

if [ -z "${SOLANA_URL:-}" ]; then
  [ -s "$SOLANA_URL_FILE" ] ||
    fail "SOLANA_URL is not set and $SOLANA_URL_FILE is missing or empty. Mount the private RPC file there, read-only: one line, the address. Or set SOLANA_URL."
  SOLANA_URL=$(tr -d ' \t\r\n' <"$SOLANA_URL_FILE") ||
    fail "$SOLANA_URL_FILE cannot be read by user $(id -u). Make it readable by the user the container runs as."
  [ -n "$SOLANA_URL" ] ||
    fail "$SOLANA_URL_FILE holds no address. Put the private RPC address in it, one line."
fi

key="$KEYS_DIR/$NETWORK-$tool.json"
[ -s "$key" ] ||
  fail "The ${tool}'s key is missing: expected the file $key. Mount it there, read-only. Without it the ${tool} would make a new key of its own, which holds nothing."
[ -s "$DEPLOYMENT" ] ||
  fail "The deployment description is missing: expected the file $DEPLOYMENT. Mount the description 'make mainnet-setup' wrote there, read-only."
[ -s "$BUILT_PROGRAM" ] ||
  fail "The program build is missing: expected the file $BUILT_PROGRAM. Mount target/mainnet/$MAINNET_PROGRAM_ID/noirwire_orderbook.so there, read-only: the ${tool} sends only when the program on mainnet is that build, byte for byte."

export SOLANA_URL
export PROGRAM_ID="${PROGRAM_ID:-$MAINNET_PROGRAM_ID}"
export PRIVATE_URL="${PRIVATE_URL:-$ROLLUP_URL}"
export DEPOSIT_URL="${DEPOSIT_URL:-$ROLLUP_URL}"

exec node_modules/.bin/ts-node -P tsconfig.json "ops/$tool.ts"
