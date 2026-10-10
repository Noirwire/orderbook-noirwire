# Everything this repository does goes through here.
#
#   make install        install the JavaScript dependencies (program, client and tests)
#   make build          compile the program and its interface file
#   make test           build, then run the tests against a fresh local network
#   make unit           run the tests that need no network
#   make up             start the local network in the background, wait until it is ready
#   make down           stop a network started with `make up`
#   make check          format, lint and type checks, as CI runs them
#   make format         fix formatting
#   make audit          check the Rust dependencies against known advisories
#   make sdk            build the client and pack it into its one release file
#   make clean          remove the local network and build leftovers
#
#   make local-setup    set up an exchange, a ledger, three markets, two test mints,
#                       custody and a faucet on the running local network; prints JSON
#   make local-status   show that deployment
#   make local-smoke    trade on it as two kept traders, count and time orders
#   make devnet-setup   the same against devnet, with keys under .keys and public custody
#   make devnet-status
#   make devnet-smoke
#
# The local network is a Solana validator, a private rollup and its query
# filter:  client -> query filter (6699) -> rollup (7799) -> Solana (8899).
# Everything it writes lives under .localnet, which git ignores.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

# The Anchor version this program is built with, the same as the anchor-lang
# crate. Where avm has it installed it is used directly, whatever version avm
# currently points at. Any other version is refused, not quietly used.
ANCHOR_VERSION := 1.2.1
AVM_ANCHOR := $(HOME)/.avm/bin/anchor-$(ANCHOR_VERSION)
ANCHOR ?= $(if $(wildcard $(AVM_ANCHOR)),$(AVM_ANCHOR),anchor)
SBPF_ARCH := v0

LOCALNET := .localnet
PROGRAM_ID := $(shell sed -n 's/^noirwire_orderbook = "\(.*\)"/\1/p' Anchor.toml)
PROGRAM_SO := target/deploy/noirwire_orderbook.so
IDL := target/idl/noirwire_orderbook.json
ADMIN_KEY := $(LOCALNET)/admin.json
STACK_LOG := $(LOCALNET)/stack.log
STACK_PID := $(LOCALNET)/stack.pid
STACK_READY := MagicBlock stack is ready
LOCAL_VALIDATOR := mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
TESTS := tests/orderbook.test.ts
UNIT_TESTS := tests/client.test.ts tests/ops.test.ts
MOCHA := NODE_OPTIONS=--no-experimental-strip-types npx ts-mocha -p ./tsconfig.json
RUN := node_modules/.bin/ts-node -P tsconfig.json
# lsof exits non-zero when any one of the ports is free, so its output is what counts.
PORTS := lsof -nP -iTCP:8899 -iTCP:7799 -iTCP:6699 -sTCP:LISTEN 2>/dev/null || true

# The stack runs from inside .localnet, so its paths are relative to there.
# The program is loaded at its declared address with a throwaway key as its
# upgrade authority, so no real key is ever needed to test.
STACK = cd $(LOCALNET) && exec npx mb-stack --reset --ledger ledger \
	--account $(LOCAL_VALIDATOR) ../tests/fixtures/local-validator-identity.json \
	--upgradeable-program $(PROGRAM_ID) ../$(PROGRAM_SO) \
		$$(solana-keygen pubkey admin.json)

WAIT_FOR_STACK = for _ in $$(seq 1 180); do \
		grep -q "$(STACK_READY)" $(STACK_LOG) && break; \
		kill -0 $$stack 2>/dev/null || { cat $(STACK_LOG) >&2; exit 1; }; \
		sleep 1; \
	done; \
	grep -q "$(STACK_READY)" $(STACK_LOG) || { cat $(STACK_LOG) >&2; exit 1; }

.PHONY: help install build pinned-anchor fresh up down test unit check format audit sdk sdk-build clean \
	local-setup local-status local-smoke devnet-setup devnet-status devnet-smoke

help:
	@grep -E '^#( |$$)' Makefile | sed -E 's/^# ?//' | sed '/^The Anchor version/,$$d'

install:
	npm ci

# The program's address is the one it declares. Its keypair is needed only
# to deploy and is not in this repository, so the build does not look for it.
#
# Anchor $(ANCHOR_VERSION) builds for the newest program format (v3) unless
# told otherwise. The local validators do not load it ("Program is not
# deployed"), so the format every validator loads is asked for by name.
build: pinned-anchor
	$(ANCHOR) build --ignore-keys --arch $(SBPF_ARCH)

pinned-anchor:
	@[ "$$($(ANCHOR) --version 2>/dev/null)" = "anchor-cli $(ANCHOR_VERSION)" ] || { \
		echo "This program builds with Anchor $(ANCHOR_VERSION) only: run 'avm install $(ANCHOR_VERSION)'." >&2; exit 1; }

$(ADMIN_KEY):
	mkdir -p $(LOCALNET)
	solana-keygen new --no-bip39-passphrase --silent --outfile $@

# A fresh network every time: state left in the rollup by an earlier run
# would disagree with a Solana ledger that was just reset.
fresh: build $(ADMIN_KEY)
	rm -rf $(LOCALNET)/ledger $(LOCALNET)/magicblock-test-storage $(LOCALNET)/deployment.json

up: fresh
	@[ -z "$$($(PORTS))" ] || { echo "A network is already running. Run 'make down'." >&2; exit 1; }
	( $(STACK) ) > $(STACK_LOG) 2>&1 & stack=$$!; echo $$stack > $(STACK_PID); \
	$(WAIT_FOR_STACK)
	@echo "Network is up. Log: $(STACK_LOG)"

down:
	@[ -f $(STACK_PID) ] && kill $$(cat $(STACK_PID)) 2>/dev/null || true
	@for _ in $$(seq 1 30); do [ -z "$$($(PORTS))" ] && break; sleep 1; done
	@rm -f $(STACK_PID)
	@[ -z "$$($(PORTS))" ] && echo "Network is down." || { echo "Ports are still held:" >&2; $(PORTS) >&2; exit 1; }

# The tests and the ops script use the built client, so the suite proves the
# very files a release packs. Node 24+ would load the .ts test file itself,
# half-loading the client as an ES module before mocha falls back to ts-node,
# so its own TypeScript loading is switched off for the run.
test: fresh unit
	( $(STACK) ) > $(STACK_LOG) 2>&1 & stack=$$!; \
	trap 'kill $$stack 2>/dev/null || true; wait $$stack 2>/dev/null || true' EXIT; \
	$(WAIT_FOR_STACK); \
	$(MOCHA) -t 600000 $(TESTS)

# The client against a fake connection: result matching, order keys under
# concurrent calls, failures and timing; and what the ops scripts decide and
# report. No network is started or needed.
unit: sdk-build
	$(MOCHA) -t 60000 $(UNIT_TESTS)

# The engine crate is checked and tested on its own (`cargo test -p
# noirwire-orderbook-engine`); these targets cover the program and the
# TypeScript.
check: sdk-build
	cargo fmt -p noirwire-orderbook -- --check
	cargo clippy --locked -p noirwire-orderbook --all-targets -- -D warnings
	npx prettier --check .
	npx tsc --noEmit -p sdk/tsconfig.json
	npx tsc --noEmit -p tsconfig.json

format:
	cargo fmt -p noirwire-orderbook
	npx prettier --write .

# Needs cargo-audit (cargo install cargo-audit --locked).
audit:
	cargo audit

sdk-build:
	npm run build --workspace sdk

# The client, built to sdk/dist and packed the way a release is consumed:
# a .tgz that an app's package.json points at by URL. Only the current
# version's file is kept.
sdk: sdk-build
	rm -f sdk/*.tgz
	cd sdk && npm pack --pack-destination .

# A deployment is operated by ops/network.ts and proven by ops/smoke.ts.
# Both are told the network through these variables (ops/deployment.ts reads
# them) and check the genesis hash and the rollup's identity before they send
# anything. On the local network the keys are the
# throwaway ones under .localnet; on devnet they live under .keys, which git
# ignores, and <network>-admin.json is put there by hand.
#
# CUSTODY is how a network's tokens are registered: sealed (nobody reads the
# custody balance) or public (anyone reads each token's total in custody, and
# so every deposit and withdrawal; SECURITY.md says what that shows). It is
# recorded with each token and cannot be changed afterwards.
#
# DEPOSIT_URL is where token registration, deposits and withdrawals are sent.
# A private endpoint, the local query filter and the hosted one alike, refuses
# a transaction of this program that names a private token balance
# (spike/devnet/README.md has what was measured). With sealed custody it is
# therefore the rollup's own port, which only the local network has. Devnet
# has the private endpoint only, so its custody is public.
LOCAL_CUSTODY ?= sealed
DEVNET_CUSTODY ?= public
OPS := $(RUN) ops/network.ts
LOCAL := NETWORK=localnet KEYS_DIR=$(LOCALNET) \
	SOLANA_URL=http://127.0.0.1:8899 \
	ROLLUP_URL=http://127.0.0.1:7799 \
	PRIVATE_URL=http://127.0.0.1:6699 \
	DEPOSIT_URL=http://127.0.0.1:7799 \
	CUSTODY=$(LOCAL_CUSTODY) \
	VALIDATOR=$(LOCAL_VALIDATOR) \
	EXCHANGE_FLOAT_LAMPORTS=200000000 \
	DEPLOYMENT=$(LOCALNET)/deployment.json
DEVNET := NETWORK=devnet KEYS_DIR=.keys \
	SOLANA_URL=https://api.devnet.solana.com \
	GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG \
	ROLLUP_URL=https://devnet-tee.magicblock.app \
	PRIVATE_URL=https://devnet-tee.magicblock.app \
	DEPOSIT_URL=https://devnet-tee.magicblock.app \
	CUSTODY=$(DEVNET_CUSTODY) \
	VALIDATOR=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo \
	EXCHANGE_FLOAT_LAMPORTS=200000000 \
	DEPLOYMENT=.keys/devnet-deployment.json

$(IDL):
	$(MAKE) build

local-setup local-status: local-%: $(IDL) $(ADMIN_KEY) sdk-build
	@[ -n "$$($(PORTS))" ] || { echo "The local network is not running. Run 'make up'." >&2; exit 1; }
	@$(LOCAL) $(OPS) $*

devnet-setup devnet-status: devnet-%: $(IDL) sdk-build
	@$(DEVNET) $(OPS) $*

# Two kept traders, a price, a fill, who can read what, a cancel, and the
# requests and time an order takes with its result pushed and polled for,
# against the deployment `setup` described.
local-smoke: $(IDL) sdk-build
	@$(LOCAL) $(RUN) ops/smoke.ts

devnet-smoke: $(IDL) sdk-build
	@$(DEVNET) $(RUN) ops/smoke.ts

clean:
	rm -rf $(LOCALNET) target/debug target/release target/sbpf-solana-solana sdk/dist sdk/*.tgz
