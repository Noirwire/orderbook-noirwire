# Everything this repository does goes through here.
#
#   make install        install the JavaScript dependencies (program, client and tests)
#   make build          compile the test networks' program and its interface file
#   make build-mainnet  compile the program mainnet deploys, and its interface file,
#                       under target/mainnet/<id>; DECLARED_ID=<id> builds it to
#                       declare that program id instead of the repository's own
#   make check-mainnet  build that, then prove neither has an instruction that
#                       writes a price and both declare that id
#   make test           build, then run the tests against a fresh local network
#   make test-audit     the same, then the security audit's tests that need the network
#   make test-upgrade   the story on an earlier build (UPGRADE_FROM=<its .so>), this
#                       build deployed over it, then the access lists' audit
#   make unit           run the tests that need no network
#   make up             start the local network in the background, wait until it is ready
#   make down           stop a network started with `make up`
#   make check          format, lint and type checks, as CI runs them
#   make format         fix formatting
#   make audit          check the Rust dependencies against known advisories
#   make sdk            build the client and pack it into its one release file
#   make mcp            build the client, then the MCP server for AI agents (devnet only)
#   make image-amd64    build the operator image (crank and keeper, docs/LAUNCH.md) for
#   make image-arm64    linux/amd64 or linux/arm64 and load it into the local Docker as
#                       noirwire-orderbook:local-<arch>; IMAGE=<name> and IMAGE_TAG=<tag>
#                       name it otherwise (a release is tagged with its commit). Docker
#                       with buildx builds the other architecture under emulation, slowly
#   make image-digest   print the digest the base image's tag names now (a read of the
#                       registry), to compare with the Dockerfile's pin before taking a newer one
#   make clean         remove the local network and build leftovers
#
#   make local-setup    set up an exchange, a ledger, three markets, two test mints,
#                       custody and a faucet on the running local network; prints JSON
#   make local-status   show that deployment
#   make local-smoke    trade on it as two kept traders, count and time orders
#   make local-access   the admin's access lists on that deployment, by ACCESS=show,
#                       market (MARKET=<id> MAKERS=on|off TAKERS=on|off) or seat
#                       (SEAT_OWNER=<key> MAKER_MARKETS=<ids|none> TAKER_MARKETS=<ids|none>
#                       BLOCKED=yes|no); show prints each perp market's switches, a seat's
#                       lists are sealed and never read back
#   make local-fund     the admin mints OWNER=<key> a seat's worth of the test quote token,
#                       AMOUNT=<whole tokens>, and deposits it as collateral to that
#                       trader's open seat; stops if the seat is not open or the custody
#                       cap would be passed, and never raises the cap
#   make local-faucet   gives a network that has no faucet one: the key <network>-faucet.json
#                       (made if missing, never printed) is topped up to AMOUNT=<whole tokens>
#                       of the test quote token, minted by the admin, and named as `faucet`
#                       in the deployment description
#   make devnet-setup   the same against devnet, with keys under .keys and public custody
#   make devnet-status
#   make devnet-smoke
#
#   make rehearsal-setup   the mainnet launch on devnet, at the program id of
#                          .keys/rehearsal-program.json, once the program there is
#                          the check-mainnet build for that id: one quote token,
#                          SOL-PERP bound to Pyth, the USDC guard,
#                          funding, INSURANCE_USDC of insurance (3000 by default, 300
#                          at the least) with the caps sized from it, a
#                          keeper's seat opened and funded with KEEPER_DEPOSIT
#                          (required), and the first mark checked against
#                          the median of public exchange prices and insurance
#                          (RESUME_MARKET=yes opens the market, and only once the
#                          keeper is funded and running: start it after the run that
#                          funds it, then run setup again); prints JSON; safe to
#                          repeat. The mark check needs no key. A Pyth Pro token is
#                          optional and adds Pyth Pro to the median: the rehearsal and
#                          mainnet targets read it from .keys/pyth-token (git ignores
#                          it) when that file exists, else from PYTH_PRO_TOKEN, and
#                          never print it
#                          REHEARSAL_SOLANA_URL=<url> names another devnet RPC
#   make rehearsal-status
#   make rehearsal-smoke   deposit, fill, cancel and the privacy checks at Pyth's mark
#   make rehearsal-crank   reads every bound Pyth account each CRANK_EVERY seconds (1 by
#                          default) and sends sync_price or sync_quote for a newer one;
#                          CRANK_PUSH=1 first posts Hermes updates when Pyth's mainnet
#                          rules say one is due (Hermes needs HERMES_TOKEN, a Pyth
#                          Core API key, which is not the Pyth Pro token)
#   make rehearsal-keeper  blind liquidation sweeps from the keeper's seat over every
#                          seat of the ledger (the exchange's seat capacity),
#                          shortfall covers, and the release of empty seats
#   make rehearsal-relayout  moves a paused exchange with the old seat layout onto
#                          the current one (migrate, copy every seat, check), and
#                          grows the ledger to LEDGER_SEATS when it is set, as its
#                          admin; local-relayout and devnet-relayout are the same
#                          on those networks; mainnet goes through the console
#   make rehearsal-drills  price incidents on purpose, each proved against RULES and
#                          undone: guard-trip, stale-price and rebind, as the smoke's
#                          traders; DRILLS=a,b picks some; never on mainnet
#   make rehearsal-faucet  local-faucet on the rehearsal, sent as its admin; no mainnet target,
#                          and ops/faucet.ts refuses a mainnet genesis itself
#   make rehearsal-access  local-access on the rehearsal, sent as its admin
#   make rehearsal-fund    local-fund on the rehearsal, sent as its admin; no mainnet target,
#                          and ops/fund.ts refuses a mainnet genesis itself
#   make rehearsal-propose-admin   the admin names the next admin, NEW_ADMIN=<public key>,
#                          with propose_admin; refuses a key that cannot sign, the current
#                          admin and the upgrade authority, and says what the nominee does
#                          next (accept_admin, signed from the admin console)
#   make rehearsal-upgrade-authority   MULTISIG=<vault address>: prints the solana command
#                          that moves the program's upgrade authority there (it sends
#                          nothing), then reads who the upgrade authority is; run it again
#                          after the command to check the move
#   make rehearsal-update-market   OPEN_INTEREST_CAP=<lots> POSITION_CAP=<lots>: shows the
#                          change to the launch market's caps and sends it only with
#                          APPLY=yes; it only lowers or keeps the caps, or raises them back
#                          within the launch's own figures and what insurance covers
#   make rehearsal-seat    the house maker's seat, by SEAT=show|open|deposit|withdraw and,
#                          for the last two, AMOUNT=<whole USDC>; the maker's key is
#                          .keys/<network>-maker.json, open needs the gate key beside it,
#                          and a deposit never mints
#   make rehearsal-exit    the way out to Solana for one seat, signed by its owner's key:
#                          KEYFILE=<the owner's key file> AMOUNT=<tokens, such as 0.25>
#                          withdraws that much of the seat's collateral into the owner's
#                          token account in the rollup, sends it on to the owner's token
#                          account on Solana, prints the Solana balance before and after
#                          and every signature, and fails unless the balance rose by what
#                          was sent. METHOD=shuttle (default) or undelegate (the older two
#                          steps, which send the owner's whole balance in the rollup);
#                          FROM=rollup skips the seat's withdrawal, to finish a run whose
#                          second step failed (it also carries on a run that stopped after
#                          the balance came back to Solana, and sends nothing twice). The
#                          steps on Solana are paid in SOL: by the owner when it holds
#                          about 0.01 SOL there, else on a test network by the admin key,
#                          else the run stops before sending anything and says what to send
#   make rehearsal-round-trip   KEYFILE=<the owner's key file> [AMOUNT=<tokens, 0.01 by
#                          default, 2 at the most>] [METHOD=...]: deposits that dust into
#                          the owner's open seat, exits it as above, and fails unless the
#                          owner ends with at least what it started with on Solana; on a
#                          test network the admin key mints what the owner lacks
#   make rehearsal-markcheck   the mark check on its own, after launch: reads and prints
#                          the market's status, the mark, the median of the public
#                          exchanges' prices, what insurance covers against the open
#                          interest cap, the upgrade authority, and the keeper's seat,
#                          funding and liveness (it watches the keeper's view for a
#                          write: give it the keeper's KEEPER_EVERY), then says plainly
#                          whether a resume is safe. It needs no admin key, sends nothing
#                          and refuses nothing. INSURANCE_HELD=<whole USDC, from the
#                          console> can only lower the insurance the cover is sized from
#   make rehearsal-keeper-deposit   KEYFILE=<a funded wallet's key file> AMOUNT=<whole USDC>
#                          [KEEPER=<the keeper's public key>]: deposits into the keeper's
#                          seat from that wallet, which is not the admin's, so it works once
#                          the admin key is gone
#   make rehearsal-float-topup   KEYFILE=<a funded wallet's key file> AMOUNT=<SOL, 5 at the
#                          most>: tops up the exchange's float on the rollup, which pays
#                          the rent of new views and of the ledger's growth, with
#                          MagicBlock's delegated lamports transfer (SOL sent to the
#                          delegated exchange on Solana never reaches the rollup); any
#                          funded wallet, not only the admin's; fails unless the float is
#                          seen the amount higher, a reading of the float and not of the
#                          transfer, so run one top-up at a time
#   make rehearsal-owner-actions   [AMOUNT=<tokens, 0.01 by default, 2 at the most>]: with a
#                          throwaway owner key held in memory only, the gate opens its
#                          trader from the owner's signed message, the owner's signed
#                          message replaces its order keys (also from a fresh fee payer
#                          that has no account, and from a signature over the off-chain
#                          message envelope a hardware wallet makes, in either header),
#                          a replayed proof, a proof for another message, the right
#                          message with one signature byte flipped (refused by the
#                          Ed25519 check before the program runs) and an expiry too far
#                          ahead are refused, and, funded by the admin key, an order key asking for
#                          a token account that is not the owner's associated one is
#                          refused and then withdraws the collateral to the owner's token
#                          account before the owner closes the seat. One PASS or FAIL line
#                          per step with the program's error number; exits non-zero on any
#                          FAIL. On mainnet nothing is funded and AMOUNT is refused
#   make mainnet-setup, mainnet-status, mainnet-smoke, mainnet-crank, mainnet-keeper,
#   make mainnet-access, mainnet-propose-admin, mainnet-upgrade-authority,
#   make mainnet-update-market, mainnet-seat, mainnet-exit, mainnet-round-trip,
#   make mainnet-markcheck, mainnet-keeper-deposit, mainnet-float-topup,
#   make mainnet-owner-actions   the same sixteen on mainnet; refused
#                          unless MAINNET_PROGRAM_ID names the program they send to
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
TOOLS_VERSION := v1.57

LOCALNET := .localnet
PROGRAM_ID := $(shell sed -n 's/^noirwire_orderbook = "\(.*\)"/\1/p' Anchor.toml)
PROGRAM_SO := target/deploy/noirwire_orderbook.so
ADMIN_KEY := $(LOCALNET)/admin.json
STACK_LOG := $(LOCALNET)/stack.log
STACK_PID := $(LOCALNET)/stack.pid
STACK_READY := MagicBlock stack is ready
LOCAL_VALIDATOR := mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
TESTS := tests/orderbook.test.ts
UNIT_TESTS := tests/instructions.test.ts tests/client.test.ts tests/viewFeed.test.ts tests/ops.test.ts tests/mcp.test.ts tests/seats.test.ts
MOCHA := NODE_OPTIONS=--no-experimental-strip-types npx ts-mocha -p ./tsconfig.json
RUN := node_modules/.bin/ts-node -P tsconfig.json
# lsof exits non-zero when any one of the ports is free, so its output is what counts.
PORTS := lsof -nP -iTCP:8899 -iTCP:7799 -iTCP:6699 -sTCP:LISTEN 2>/dev/null || true

# The stack runs from inside .localnet, so its paths are relative to there.
# The program is loaded at its declared address with a throwaway key as its
# upgrade authority, so no real key is ever needed to test.
STACK_SO = ../$(PROGRAM_SO)
STACK = cd $(LOCALNET) && exec npx mb-stack --reset --ledger ledger \
	--account $(LOCAL_VALIDATOR) ../tests/fixtures/local-validator-identity.json \
	--upgradeable-program $(PROGRAM_ID) $(STACK_SO) \
		$$(solana-keygen pubkey admin.json)

WAIT_FOR_STACK = for _ in $$(seq 1 180); do \
		grep -q "$(STACK_READY)" $(STACK_LOG) && break; \
		kill -0 $$stack 2>/dev/null || { cat $(STACK_LOG) >&2; exit 1; }; \
		sleep 1; \
	done; \
	grep -q "$(STACK_READY)" $(STACK_LOG) || { cat $(STACK_LOG) >&2; exit 1; }

.PHONY: help install build build-mainnet check-mainnet pinned-anchor fresh up down test test-audit test-upgrade unit check format audit sdk sdk-build mcp image-amd64 image-arm64 image-digest clean \
	local-setup local-status local-smoke local-access local-fund local-faucet local-relayout devnet-setup devnet-status devnet-smoke devnet-relayout \
	rehearsal-setup rehearsal-status rehearsal-smoke rehearsal-crank rehearsal-keeper rehearsal-drills rehearsal-access rehearsal-fund rehearsal-faucet rehearsal-relayout \
	rehearsal-propose-admin rehearsal-upgrade-authority rehearsal-update-market rehearsal-seat \
	rehearsal-exit rehearsal-round-trip rehearsal-markcheck rehearsal-keeper-deposit rehearsal-float-topup rehearsal-owner-actions \
	mainnet-setup mainnet-status mainnet-smoke mainnet-crank mainnet-keeper mainnet-access \
	mainnet-propose-admin mainnet-upgrade-authority mainnet-update-market mainnet-seat \
	mainnet-exit mainnet-round-trip mainnet-markcheck mainnet-keeper-deposit mainnet-float-topup mainnet-owner-actions

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
# The platform tools are named too, so the same sources give the same binary.
#
# This is the test networks' program, the one the local network and devnet
# load: the test-oracle feature adds `publish_price` and `reset_price`, so
# their markets can be bound to no price source and priced by the oracle key.
# Mainnet deploys the default build, which has neither. build-mainnet puts
# it and its interface file under target/mainnet/<id>, apart from the test
# networks' files, and check-mainnet refuses either if it has a price writer:
# by name in the interface file, and by instruction discriminator (the first
# 8 bytes of sha256("global:" || name), which Anchor dispatches on) in the
# binary itself.
#
# The build declares DECLARED_ID, the repository's own program id unless told
# another, so a rehearsal or a launch at a program id of its own gets a binary
# that declares that id with no source edited: the program's sources are
# copied under target/declared/<id>/src and the copy's declare_id! is
# rewritten. Each id builds in a cargo target folder of its own: cargo tracks
# a build by the paths of the files it read, so copies of the same sources
# at two paths would share one and the second would take the first's binary.
# The rehearsal and mainnet targets refuse to send unless the program deployed
# at their id is that build byte for byte.
TEST_NETWORK_FEATURES := test-oracle
DECLARED_ID ?= $(PROGRAM_ID)
DECLARED_SRC = $(CURDIR)/target/declared/$(DECLARED_ID)/src
DECLARED_LIB = $(DECLARED_SRC)/programs/noirwire-orderbook/src/lib.rs
MAINNET_DIR = $(CURDIR)/target/mainnet/$(DECLARED_ID)
MAINNET_SO = $(MAINNET_DIR)/noirwire_orderbook.so
MAINNET_IDL = $(MAINNET_DIR)/noirwire_orderbook.json
IN_DECLARED_SRC = cd $(DECLARED_SRC) && CARGO_TARGET_DIR=$(CURDIR)/target/declared/$(DECLARED_ID)/target

build: pinned-anchor
	$(ANCHOR) build --ignore-keys --arch $(SBPF_ARCH) --tools-version $(TOOLS_VERSION) \
		-- --features $(TEST_NETWORK_FEATURES)

build-mainnet: pinned-anchor
	@[[ "$(DECLARED_ID)" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$$ ]] || { echo "DECLARED_ID '$(DECLARED_ID)' is not a program id." >&2; exit 1; }
	rm -rf $(DECLARED_SRC)
	mkdir -p $(DECLARED_SRC)/programs $(DECLARED_SRC)/crates $(DECLARED_SRC)/sdk/src
	cp Cargo.toml Cargo.lock Anchor.toml rust-toolchain.toml $(DECLARED_SRC)
	cp -R programs/noirwire-orderbook $(DECLARED_SRC)/programs
	cp -R crates/engine $(DECLARED_SRC)/crates
	cp sdk/src/constants.ts $(DECLARED_SRC)/sdk/src
	sed -i.orig -E 's/^declare_id!\(".*"\);$$/declare_id!("$(DECLARED_ID)");/' $(DECLARED_LIB)
	grep -qx 'declare_id!("$(DECLARED_ID)");' $(DECLARED_LIB)
	$(IN_DECLARED_SRC) $(ANCHOR) build --ignore-keys --no-idl --arch $(SBPF_ARCH) --tools-version $(TOOLS_VERSION) \
		-- --sbf-out-dir $(MAINNET_DIR)
	$(IN_DECLARED_SRC) $(ANCHOR) idl build -p noirwire_orderbook -o $(MAINNET_IDL)

check-mainnet: build-mainnet
	@$(RUN) ops/mainnet-build.ts "$(MAINNET_IDL)" "$(MAINNET_SO)" "$(DECLARED_ID)"

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

# The same story, then the security audit's proofs that need the network:
# custody claimed before registration, the price feed, seat probes, and a
# full book's eviction, compute and what a stranger sees.
test-audit:
	$(MAKE) test TESTS=tests/audit.test.ts

# An in-place upgrade. The network starts with an earlier build at the
# program's address, the story runs on it, this build is deployed over it with
# the local upgrade authority, and the access lists' audit then runs on the
# state the earlier build left: its first test reads every access byte of
# that state as zero. UPGRADE_FROM is the earlier build's test-network
# program, made by `make build` at the commit to upgrade from
# (target/deploy/noirwire_orderbook.so there).
ifneq ($(filter test-upgrade,$(MAKECMDGOALS)),)
ifeq ($(wildcard $(UPGRADE_FROM)),)
$(error Set UPGRADE_FROM to the earlier build's program file)
endif
endif
test-upgrade: STACK_SO = $(abspath $(UPGRADE_FROM))
test-upgrade: fresh unit
	( $(STACK) ) > $(STACK_LOG) 2>&1 & stack=$$!; \
	trap 'kill $$stack 2>/dev/null || true; wait $$stack 2>/dev/null || true' EXIT; \
	$(WAIT_FOR_STACK); \
	UPGRADE_SO=$(CURDIR)/$(PROGRAM_SO) $(MOCHA) -t 600000 tests/upgrade.test.ts

# The client's instruction builders against the program's interface file and
# a recorded snapshot of their accounts and bytes; the client against a fake
# connection: result matching, order keys under concurrent calls, failures and
# timing; what the ops scripts decide and report; and the MCP server's units,
# account mapping and outcome wording. No network is started or needed, but
# the interface file comes from `make build`.
unit: $(IDL) sdk-build mcp
	$(MOCHA) -t 60000 $(UNIT_TESTS)

# The engine crate is checked and tested on its own (`cargo test -p
# noirwire-orderbook-engine`); these targets cover the program and the
# TypeScript.
check: mcp
	cargo fmt -p noirwire-orderbook -- --check
	cargo clippy --locked -p noirwire-orderbook --all-targets -- -D warnings
	cargo clippy --locked -p noirwire-orderbook --all-targets --features $(TEST_NETWORK_FEATURES) -- -D warnings
	npx prettier --check .
	npx tsc --noEmit -p sdk/tsconfig.json
	npx tsc --noEmit -p mcp/tsconfig.json
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

# The MCP server, built to mcp/dist. Run it with `node mcp/dist/index.js`.
mcp: sdk-build
	npm run build --workspace mcp

# The operator image: the crank and the keeper, built from the Dockerfile at the
# repository root and the allow list in .dockerignore, so only the sources the
# build reads go in, never a key, a description or a build under target/. One
# target per architecture, each loaded into the local Docker under its own tag.
IMAGE ?= noirwire-orderbook
IMAGE_TAG ?= local
image-amd64 image-arm64: image-%:
	docker buildx build --platform linux/$* --load --tag $(IMAGE):$(IMAGE_TAG)-$* .

# The Dockerfile pins its base image by digest. This prints the digest the tag
# names now, read from the registry and changing nothing, to compare with the
# pin and to take a newer base on purpose.
image-digest:
	docker buildx imagetools inspect node:$$(sed -n 's/^ARG NODE_VERSION=//p' Dockerfile)-bookworm-slim | sed -n 's/^Digest: */ARG NODE_DIGEST=/p'

# A deployment is operated by ops/network.ts and proven by ops/smoke.ts.
# Both are told the network through these variables (ops/deployment.ts reads
# them) and check the genesis hash and the rollup's identity before they send
# anything. GENESIS is required: a network's genesis hash, or local for the
# local validator, whose genesis is new with each reset and which must not be
# a public cluster. Only NETWORK=mainnet runs on mainnet's genesis, and the
# mainnet profile runs on mainnet and the rehearsal only. On the local network the keys are the
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
	PUBLIC_SOLANA_URL=http://127.0.0.1:8899 \
	GENESIS=local \
	ROLLUP_URL=http://127.0.0.1:7799 \
	PRIVATE_URL=http://127.0.0.1:6699 \
	DEPOSIT_URL=http://127.0.0.1:7799 \
	CUSTODY=$(LOCAL_CUSTODY) \
	VALIDATOR=$(LOCAL_VALIDATOR) \
	EXCHANGE_FLOAT_LAMPORTS=200000000 \
	DEPLOYMENT=$(LOCALNET)/deployment.json
DEVNET := NETWORK=devnet KEYS_DIR=.keys \
	SOLANA_URL=https://api.devnet.solana.com \
	PUBLIC_SOLANA_URL=https://api.devnet.solana.com \
	GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG \
	ROLLUP_URL=https://devnet-tee.magicblock.app \
	PRIVATE_URL=https://devnet-tee.magicblock.app \
	DEPOSIT_URL=https://devnet-tee.magicblock.app \
	CUSTODY=$(DEVNET_CUSTODY) \
	VALIDATOR=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo \
	EXCHANGE_FLOAT_LAMPORTS=200000000 \
	DEPLOYMENT=.keys/devnet-deployment.json

local-setup local-status: local-%: $(ADMIN_KEY) sdk-build
	@[ -n "$$($(PORTS))" ] || { echo "The local network is not running. Run 'make up'." >&2; exit 1; }
	@$(LOCAL) $(OPS) $*

devnet-setup devnet-status: devnet-%: sdk-build
	@$(DEVNET) $(OPS) $*

# Two kept traders, a price, a fill, who can read what, a cancel, and the
# requests and time an order takes with its result pushed and polled for,
# against the deployment `setup` described.
local-smoke: sdk-build
	@$(LOCAL) $(RUN) ops/smoke.ts

devnet-smoke: sdk-build
	@$(DEVNET) $(RUN) ops/smoke.ts

# Moves a paused exchange with the old seat layout onto the current one, as its
# admin (ops/relayout.ts); LEDGER_SEATS=<n> then grows the ledger to n seats.
local-relayout: $(ADMIN_KEY) sdk-build
	@[ -n "$$($(PORTS))" ] || { echo "The local network is not running. Run 'make up'." >&2; exit 1; }
	@$(LOCAL) $(RUN) ops/relayout.ts

devnet-relayout: sdk-build
	@$(DEVNET) $(RUN) ops/relayout.ts

# The admin's access lists (ops/access.ts), by ACCESS=show|market|seat and the
# variables ops/access.ts names; a value it does not take is refused.
local-access: $(ADMIN_KEY) sdk-build
	@[ -n "$$($(PORTS))" ] || { echo "The local network is not running. Run 'make up'." >&2; exit 1; }
	@$(LOCAL) $(RUN) ops/access.ts

# Funds a trader's seat with the test quote token (ops/fund.ts), by OWNER=<key>
# and AMOUNT=<whole tokens>. The seat is the trader's own, opened through the
# gate before this runs.
local-fund: $(ADMIN_KEY) sdk-build
	@[ -n "$$($(PORTS))" ] || { echo "The local network is not running. Run 'make up'." >&2; exit 1; }
	@$(LOCAL) $(RUN) ops/fund.ts

# Gives the deployment a faucet (ops/faucet.ts), by AMOUNT=<whole tokens>.
local-faucet: $(ADMIN_KEY) sdk-build
	@[ -n "$$($(PORTS))" ] || { echo "The local network is not running. Run 'make up'." >&2; exit 1; }
	@$(LOCAL) $(RUN) ops/faucet.ts

# The mainnet launch, by the mainnet profile (PROFILE=mainnet, ops/network.ts),
# and the processes that keep it running: the crank and the liquidation
# keeper. Each runs against a program deployed at the id of its program key,
# and refuses to send unless that program is, byte for byte, the build
# `make check-mainnet DECLARED_ID=<that id>` made under target/mainnet/<id>;
# PROGRAM_ID and BUILT_PROGRAM tell the scripts, and nothing in the
# repository changes with them.
#
# The rehearsal runs it on devnet at a fresh program id, with its own
# description, so the devnet deployment is left alone. Its admin is
# .keys/rehearsal-admin.json, the program's upgrade authority. QUOTE_MINT
# names the quote token; left out, setup makes a test mint of USDC's decimals
# under .keys and the admin mints from it. Devnet's own Pyth updates come
# about every one to five minutes, too slowly for mainnet's ages, hence
# CRANK_PUSH=1 there.
#
# The mainnet targets take the same tools to mainnet with real USDC, whose
# mint the scripts check, and refuse to run unless MAINNET_PROGRAM_ID names the
# program id of .keys/mainnet-program.json, and without MAINNET_ROLLUP_URL and
# MAINNET_VALIDATOR, the endpoint and identity of the rollup the exchange is
# delegated to, which are chosen at launch; on mainnet the scripts also stop
# unless that rollup serves mainnet's USDC mint. The market stays reduce-only
# while the admin is the program's upgrade authority.
#
# Variables the steps read, for setup: RESUME_MARKET=yes, which opens the
# market on the launch's runs only; INSURANCE_USDC, the whole USDC the launch
# funds as insurance (3000 by default, never under 300), from which the open
# interest cap and the position cap are sized (a launch at 500 opens with
# about a sixth of the default's caps), the same for every target of the
# launch: once setup has funded insurance, the deployment records the amount
# and a different INSURANCE_USDC is refused; and KEEPER_DEPOSIT (whole quote
# tokens). KEEPER_DEPOSIT is required, the same for every run of the launch (resume
# included): setup records the keeper's seat opening and its deposit like
# insurance, never signs with the keeper's order keys (a running keeper replaces
# them with every sweep). KEEPER_DEPOSIT is the total the keeper's seat is given:
# raised, the next run deposits the difference (once, under its own pending
# record), and a lower figure than the one recorded is refused. Once the admin
# key is gone, make mainnet-keeper-deposit tops the seat up from any funded
# wallet. INSURANCE_USDC has no default on mainnet. INSURANCE_FIRST_SEND=yes,
# on the first run only, where the rollup does not serve custody and nothing
# records an insurance send. MULTISIG_IS_A_KEY=yes lets upgrade-authority take
# an address on the curve. EXIT_SENT=landed:<id> or lost:<id> answers an exit's
# seat withdrawal whose outcome is unknown (exits are recorded under .keys; the
# round trip needs about 0.03 SOL, the exit 0.01). INSURANCE_HELD (whole USDC, read from the console) can only lower the
# insurance the resume check and the mark check size the cover from. The run
# that resumes the market (RESUME_MARKET=yes, or
# RESTORE=resume) first watches the keeper's view for a write, for as long as a
# running keeper can go between two (KEEPER_EVERY plus a minute of backoff plus
# 30 seconds, so give it the keeper's KEEPER_EVERY), and refuses unless the seat
# is funded and the keeper is running; INSURANCE_SENT, FUNDING_SENT,
# KEEPER_SEAT_SENT or KEEPER_DEPOSIT_SENT, landed:<id> or lost:<id> naming the
# record a run left pending (the run that stops prints the id), or
# INSURANCE_SENT=held:<atoms> when public custody already holds the insurance
# and it was not sent; SEATS_PER_DAY, the launch's figure by default, at most
# 4294967295 (a local network keeps the client's default); and
# RESTORE=seatsPerDay, quoteSource or resume. Once the market has opened, setup
# leaves the seats a day, the USDC guard and the market's status as it finds
# them, since the admin may have changed them during an incident, and says
# which differ; RESTORE names the one of them a run writes back, resume after
# the same mark check as at launch. MAINNET_SMOKE=yes for the smoke on
# mainnet; CRANK_EVERY (seconds between reads of every Pyth account, 1 by
# default and 10 with CRANK_PUSH), CRANK_GIVE_UP, CRANK_PUSH and CRANK_DEADLINE
# (seconds a round may take, 60) for the crank;
# KEEPER_EVERY, KEEPER_GIVE_UP, KEEPER_STALE_GIVE_UP, KEEPER_DEADLINE (seconds a
# sweep may take, 180) and KEEPER_RANGE (seats one liquidation call looks at,
# 256) for the keeper, which sweeps the exchange's whole seat capacity and
# sends release_empty_seats over it every RELEASE_EVERY_MS (600000) in calls
# of RELEASE_RANGE seats (2048);
# LEDGER_SEATS (optional) for relayout: grow the ledger to this many seats;
# HEALTHCHECK_URL (optional) for both: after each good round or sweep they send
# a plain GET to it, for a dead-man's switch outside the server; none is sent
# while an ALERT stands (the keeper's margin alert or an unclosed position, the
# crank's confidence incident), so the switch means healthy, not only alive; a
# ping that fails is logged and dropped;
# KEEPER_HEARTBEAT_FILE (optional, an absolute path) for the keeper: after each
# sweep that sends that ping it writes the time in Unix milliseconds to the
# file (atomically, mode 0644), for a service on the same host to gate its
# readiness on; a write that fails is logged once and dropped;
# DRILLS for the drills, which have no mainnet target and refuse a mainnet
# genesis in ops/drills.ts as well. Stop the crank before the guard-trip and
# stale-price drills: a guard or mark it syncs makes their checks skips, and a
# skip that leaves a drill unproven fails the run.
#
# The mark check before resume_market compares the first mark with the median
# of Coinbase, Kraken and Bitstamp's public SOL/USD prices, which need no key.
# A Pyth Pro token (https://pyth.dourolabs.app) is optional and adds Pyth Pro
# to that median. These targets read it at run time from .keys/pyth-token when
# that file exists, else keep PYTH_PRO_TOKEN from the environment; the recipe never
# echoes it and git ignores .keys. The crank's push (CRANK_PUSH=1) is Hermes's
# and takes HERMES_TOKEN instead, a Pyth Core API key: a different key.
#
# REHEARSAL_SOLANA_URL is the rehearsal's Solana RPC, devnet's public one by
# default. It is a variable because that endpoint rate-limits a launch: point
# it at another devnet RPC when a run is refused for that.
#
# The mainnet targets send through the RPC in .keys/mainnet-rpc-url when that
# file exists (git ignores it), else MAINNET_SOLANA_URL, else the public one,
# which rate-limits a launch. A paid RPC's URL carries its API key, so the
# recipe never echoes it, and the deployment description, which the market
# data service serves to anyone, names PUBLIC_SOLANA_URL instead: the public
# RPC of the same network.
REHEARSAL_PROGRAM_KEY := .keys/rehearsal-program.json
MAINNET_PROGRAM_KEY := .keys/mainnet-program.json
PYTH_PRO_TOKEN_FILE := .keys/pyth-token
PYTH_PRO_TOKEN_ARG = PYTH_PRO_TOKEN="$$( [ -f $(PYTH_PRO_TOKEN_FILE) ] && cat $(PYTH_PRO_TOKEN_FILE) || printf %s "$${PYTH_PRO_TOKEN:-}" )"
REHEARSAL_SOLANA_URL ?= https://api.devnet.solana.com
MAINNET_RPC_URL_FILE := .keys/mainnet-rpc-url
MAINNET_PUBLIC_SOLANA_URL := https://api.mainnet-beta.solana.com
MAINNET_SOLANA_URL_ARG = SOLANA_URL="$$( [ -f $(MAINNET_RPC_URL_FILE) ] && cat $(MAINNET_RPC_URL_FILE) || printf %s "$${MAINNET_SOLANA_URL:-$(MAINNET_PUBLIC_SOLANA_URL)}" )"
REHEARSAL := NETWORK=rehearsal PROFILE=mainnet KEYS_DIR=.keys \
	SOLANA_URL=$(REHEARSAL_SOLANA_URL) \
	PUBLIC_SOLANA_URL=https://api.devnet.solana.com \
	GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG \
	ROLLUP_URL=https://devnet-tee.magicblock.app \
	PRIVATE_URL=https://devnet-tee.magicblock.app \
	DEPOSIT_URL=https://devnet-tee.magicblock.app \
	CUSTODY=public \
	VALIDATOR=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo \
	EXCHANGE_FLOAT_LAMPORTS=200000000 \
	DEPLOYMENT=.keys/rehearsal-deployment.json
ON_MAINNET := NETWORK=mainnet PROFILE=mainnet KEYS_DIR=.keys \
	PUBLIC_SOLANA_URL=$(MAINNET_PUBLIC_SOLANA_URL) \
	GENESIS=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d \
	ROLLUP_URL=$(MAINNET_ROLLUP_URL) \
	PRIVATE_URL=$(MAINNET_ROLLUP_URL) \
	DEPOSIT_URL=$(MAINNET_ROLLUP_URL) \
	CUSTODY=public \
	VALIDATOR=$(MAINNET_VALIDATOR) \
	EXCHANGE_FLOAT_LAMPORTS=200000000 \
	DEPLOYMENT=.keys/mainnet-deployment.json \
	QUOTE_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
TOOL_setup := $(OPS) setup
TOOL_status := $(OPS) status
TOOL_smoke := $(RUN) ops/smoke.ts
TOOL_crank := $(RUN) ops/crank.ts
TOOL_keeper := $(RUN) ops/keeper.ts
TOOL_drills := $(RUN) ops/drills.ts
TOOL_access := $(RUN) ops/access.ts
TOOL_fund := $(RUN) ops/fund.ts
TOOL_faucet := $(RUN) ops/faucet.ts
TOOL_propose-admin := $(RUN) ops/propose-admin.ts
TOOL_upgrade-authority := $(RUN) ops/upgrade-authority.ts
TOOL_update-market := $(RUN) ops/update-market.ts
TOOL_seat := $(RUN) ops/seat.ts
TOOL_exit := $(RUN) ops/exit.ts
TOOL_round-trip := $(RUN) ops/round-trip.ts
TOOL_markcheck := $(RUN) ops/markcheck.ts
TOOL_keeper-deposit := $(RUN) ops/keeper-deposit.ts
TOOL_float-topup := $(RUN) ops/float-topup.ts
TOOL_owner-actions := $(RUN) ops/owner-actions.ts
TOOL_relayout := $(RUN) ops/relayout.ts
# The program id is the program key's public key. A key that is missing stops
# the target here: an empty PROGRAM_ID would mean the client's own id.
PROGRAM_KEY_ID = [ -f $(1) ] || { echo "$(1) is missing: its public key is the program id. Nothing was sent." >&2; exit 1; }; \
	id=$$(solana-keygen pubkey $(1))
DEPLOYED_AS = PROGRAM_ID=$$id BUILT_PROGRAM=$(CURDIR)/target/mainnet/$$id/noirwire_orderbook.so

rehearsal-setup rehearsal-status rehearsal-smoke rehearsal-crank rehearsal-keeper rehearsal-drills rehearsal-access rehearsal-fund rehearsal-faucet \
	rehearsal-propose-admin rehearsal-upgrade-authority rehearsal-update-market rehearsal-seat \
	rehearsal-exit rehearsal-round-trip rehearsal-markcheck rehearsal-keeper-deposit rehearsal-float-topup rehearsal-owner-actions rehearsal-relayout: rehearsal-%: sdk-build
	@$(call PROGRAM_KEY_ID,$(REHEARSAL_PROGRAM_KEY)); \
	$(REHEARSAL) $(PYTH_PRO_TOKEN_ARG) $(DEPLOYED_AS) $(TOOL_$*)

mainnet-setup mainnet-status mainnet-smoke mainnet-crank mainnet-keeper mainnet-access \
	mainnet-propose-admin mainnet-upgrade-authority mainnet-update-market mainnet-seat \
	mainnet-exit mainnet-round-trip mainnet-markcheck mainnet-keeper-deposit mainnet-float-topup mainnet-owner-actions: mainnet-%: sdk-build
	@[ -n "$(MAINNET_ROLLUP_URL)" ] && [ -n "$(MAINNET_VALIDATOR)" ] || { echo "Set MAINNET_ROLLUP_URL and MAINNET_VALIDATOR. Nothing was sent." >&2; exit 1; }
	@$(call PROGRAM_KEY_ID,$(MAINNET_PROGRAM_KEY)); \
	[ "$(MAINNET_PROGRAM_ID)" = "$$id" ] || { echo "This sends to mainnet, to the program $$id: run it with MAINNET_PROGRAM_ID=$$id. Nothing was sent." >&2; exit 1; }; \
	$(ON_MAINNET) $(MAINNET_SOLANA_URL_ARG) $(PYTH_PRO_TOKEN_ARG) MAINNET_PROGRAM_ID=$$id $(DEPLOYED_AS) $(TOOL_$*)

clean:
	rm -rf $(LOCALNET) target/debug target/release target/sbpf-solana-solana target/declared sdk/dist sdk/*.tgz mcp/dist
