# Measurements for a private order book on a local MagicBlock stack.
#
#   make help      this text
#   make install   install the JavaScript dependencies
#   make build     compile the spike program
#   make stack     start the local network in the foreground (Ctrl-C stops it)
#   make up        start the local network in the background, wait until ready
#   make down      stop a network started with `make up`
#   make q1        private account with no members
#   make q2        what a stranger can learn about a transaction
#   make q3        big zero-copy account, order array, compute units
#   make q4        Ephemeral SPL Token: balance into the rollup, program-signed payout
#   make q5        websocket account subscriptions
#   make q6        latency and throughput
#   make q7        the scheduler
#   make q8        read-only checks against the devnet private validator
#   make all       up, q1 to q7, down
#
# q1 to q7 need the network running (`make up`, or `make stack` in another
# terminal). The network is a Solana validator (8899), a private rollup (7799)
# and its query filter (6699). Everything it writes lives under .localnet.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

ANCHOR_VERSION := 1.2.1
AVM_ANCHOR := $(HOME)/.avm/bin/anchor-$(ANCHOR_VERSION)
ANCHOR ?= $(if $(wildcard $(AVM_ANCHOR)),$(AVM_ANCHOR),anchor)
SBPF_ARCH := v0

LOCALNET := .localnet
PROGRAM_ID := $(shell sed -n 's/^ob_spike = "\(.*\)"/\1/p' Anchor.toml)
PROGRAM_SO := target/deploy/ob_spike.so
ADMIN_KEY := $(LOCALNET)/admin.json
STACK_LOG := $(LOCALNET)/stack.log
STACK_PID := $(LOCALNET)/stack.pid
STACK_READY := MagicBlock stack is ready
LOCAL_VALIDATOR := mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
MB_STACK := ../node_modules/@magicblock-labs/ephemeral-validator/mbStack.js
RUN := node_modules/.bin/ts-node -P tsconfig.json
# lsof exits non-zero when any one of the ports is free, so its output is what counts.
PORTS := lsof -nP -iTCP:8899 -iTCP:7799 -iTCP:6699 -sTCP:LISTEN 2>/dev/null || true

STACK = cd $(LOCALNET) && exec node $(MB_STACK) --reset --ledger ledger \
	--account $(LOCAL_VALIDATOR) local-validator-identity.json \
	--upgradeable-program $(PROGRAM_ID) ../$(PROGRAM_SO) \
		$$(solana-keygen pubkey admin.json)

.PHONY: help install build fresh stack up down all q1 q2 q3 q4 q5 q6 q7 q8

help:
	@grep -E '^#( |$$)' Makefile | sed -E 's/^# ?//'

install:
	npm install --no-audit --no-fund

build:
	@[ "$$($(ANCHOR) --version 2>/dev/null)" = "anchor-cli $(ANCHOR_VERSION)" ] || { \
		echo "Needs Anchor $(ANCHOR_VERSION): run 'avm install $(ANCHOR_VERSION)'." >&2; exit 1; }
	$(ANCHOR) build --ignore-keys --arch $(SBPF_ARCH)

$(ADMIN_KEY):
	mkdir -p $(LOCALNET)
	solana-keygen new --no-bip39-passphrase --silent --outfile $@

fresh: $(ADMIN_KEY)
	@[ -f $(PROGRAM_SO) ] || $(MAKE) build
	rm -rf $(LOCALNET)/ledger $(LOCALNET)/magicblock-test-storage

stack: fresh
	$(STACK)

up: fresh
	@[ -z "$$($(PORTS))" ] || { echo "A network is already running. Run 'make down'." >&2; exit 1; }
	( $(STACK) ) > $(STACK_LOG) 2>&1 & echo $$! > $(STACK_PID); \
	for _ in $$(seq 1 180); do \
		grep -q "$(STACK_READY)" $(STACK_LOG) && break; \
		kill -0 $$(cat $(STACK_PID)) 2>/dev/null || { cat $(STACK_LOG) >&2; exit 1; }; \
		sleep 1; \
	done; \
	grep -q "$(STACK_READY)" $(STACK_LOG) || { cat $(STACK_LOG) >&2; exit 1; }
	@echo "Network is up. Log: $(STACK_LOG)"

down:
	@[ -f $(STACK_PID) ] && kill $$(cat $(STACK_PID)) 2>/dev/null || true
	@for _ in $$(seq 1 30); do [ -z "$$($(PORTS))" ] && break; sleep 1; done
	@rm -f $(STACK_PID)
	@[ -z "$$($(PORTS))" ] && echo "Network is down." || { echo "Ports are still held:" >&2; $(PORTS) >&2; exit 1; }

q1 q2 q3 q4 q5 q6 q7 q8: q%:
	$(RUN) tests/q$*.ts

all: up
	trap '$(MAKE) down' EXIT; for n in 1 2 3 4 5 6 7; do $(MAKE) q$$n; done
