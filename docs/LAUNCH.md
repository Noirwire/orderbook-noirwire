# Mainnet launch

How the operator takes the order book to mainnet, in order, and runs it afterwards. It is written for one person at one terminal. Every command is a Makefile target or a `solana` command, and every step says what to expect and when to stop. `SECURITY.md` ("Running a small mainnet market") says why each condition exists; this page says what to type.

What launches: one market, SOL-PERP (market 0, at most 5x, marked by Pyth), USDC as the only token, invite-only through the access lists, a house maker with about 1,000 USDC, insurance of 500 USDC, small caps. SOL/USDC spot is not part of this launch (see the end).

Losing money is worse than being slow. If a step does not do what it says it should, stop there. Nothing below needs to be finished in one sitting except where it says so.

## How to read the commands

Run everything from the root of this repository, on the launch machine, in one shell. The folder `.keys` (git ignores it) holds every key and every file the launch writes. Commands that send to mainnet are the `mainnet-*` targets: each refuses unless you name the program with `MAINNET_PROGRAM_ID=$ID`, and unless the program on mainnet is, byte for byte, the build you made in step 5.

```sh
export MAINNET_ROLLUP_URL=https://mainnet-tee.magicblock.app
export MAINNET_VALIDATOR=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
```

Those two name the private rollup the exchange is delegated to and the identity of its validator. Confirm both with MagicBlock before launch. The mainnet targets stop unless the endpoint reports that identity and serves mainnet's USDC mint, so a wrong pair is refused, not used.

From step 3 on, `ID` is the program id, the public key of `.keys/mainnet-program.json`:

```sh
ID=$(solana-keygen pubkey .keys/mainnet-program.json)
```

The Solana CLI can echo the keyed RPC URL in its own errors. Do not paste a CLI error anywhere (a chat, a ticket, a log), and clear the terminal's scrollback after a failed `solana` command.

## 0. What you need

- On the launch machine: Node 26 (the version CI runs), Rust (picked up from `rust-toolchain.toml`), the Solana CLI 2.3.11 and Anchor 1.2.1 (`avm install 1.2.1`) to build, `make`, `git`, `openssl`, and Docker if you run the image (below).
- For the deploy, a Solana CLI at least as new as the cluster (`solana cluster-version` shows the cluster's). The build uses 2.3.11, which may be older than mainnet.
- A private Solana RPC with an API key (a paid plan). The public RPC rate-limits a launch. Its address goes in `.keys/mainnet-rpc-url`, written with an editor, one line. Never type it into a command: it would stay in the shell history.
- The admin hardware wallet, and a second one, tested. The upgrade authority's multisig (a Squads vault, signers on separate devices, a threshold no one person meets, a time lock). The admin console (`console-noirwire`) running on your own machine.
- The infra repository (`infra-noirwire`) with its settings filled in: it runs the crank, the keeper and the services on the server.
- About 4.3 SOL for the deploy (step 4: the program's rent, 3.26 SOL at the rehearsal build's size, plus 1 SOL of margin), 0.5 SOL and 700 USDC for the admin key, and 1,000 USDC and a little SOL for the house maker.

## 1. Choose the numbers

Write these down before you start. Every one marked "same" must be the same on every run of the launch; setup refuses a different value once it has been used.

| Setting          | Starting value | What it is                                                                                                                                                             |
| ---------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSURANCE_USDC` | 500 (same)     | Whole USDC funded as insurance. The open interest cap and the position cap are sized from it. At 500 they are 18,518 and 3,703 lots (0.001 SOL each). Never under 300. |
| `KEEPER_DEPOSIT` | 200 (same)     | Whole USDC in the liquidation keeper's seat. See below.                                                                                                                |
| Maker capital    | 1,000 USDC     | What the house maker's seat holds.                                                                                                                                     |

The keeper's deposit pays the margin of a bankrupt position the keeper takes over. A full-cap position (3,703 lots, 3.7 SOL) at 5x needs 20% of its notional: 200 USDC covers one such takeover up to about 270 USDC per SOL. The keeper unwinds a position at once, so one takeover at a time is what to size for. Raise the deposit if you want room for two.

`KEEPER_DEPOSIT` is the total the keeper's seat is given, not a one-time figure. Raise it on a later `make mainnet-setup` (before step 15, while the admin key is on this machine) and that run deposits the difference, once, under a pending record of its own like every send that moves money; a figure lower than the one recorded is refused. Every takeover that loses money shrinks the keeper's collateral for good, so watch it, and top it up before it cannot carry a takeover (see "Topping up the keeper's seat" under Day to day, which works after step 15 too).

Deposits have no configurable cap: a token takes deposits as soon as it is registered, and there is no setting to raise in stages. What bounds the risk is the open interest cap and the position cap, which stay. Only a token whose total supply in atoms is below the fixed technical ceiling `BALANCE_CAP` can be registered, so USDC is always well inside it. Keep the way out for users in mind (see the end): until more than the owner-signed exit exists, invite deposits only as fast as you could make them good. Insurance, once funded, cannot be withdrawn.

Check the maker's size against the position cap before you fund it. The cap applies to the maker like any seat: its position plus its resting orders on a side plus a new order must stay within 3,703 lots (3.7 SOL, about 555 USDC at 150 USDC per SOL). A quote level of 500 USDC is 3.3 SOL, so with the maker's position band of 250 USDC (1.7 SOL) a full level does not fit. Either lower the maker's quote size per level so that one level plus the band is within the cap (the infra repository's maker settings), or raise `INSURANCE_USDC`: the caps scale with it.

## 2. The release commit

Release from a named commit, on a clean checkout, and write the commit id down. The infra repository pins the same commit.

```sh
git fetch
git checkout --detach <commit>
git status --porcelain          # prints nothing
git rev-parse HEAD              # the commit you named
export COMMIT=$(git rev-parse HEAD)
make install
make check
make build && make unit
make test-audit
make audit
```

Stop if any of them fails. `make test-audit` starts a local network and runs the security audit's proofs that need one.

Before enabling an upgrade that reads `owner_nonce` from an existing view, inspect the former four padding bytes in every live view account. They are bytes 180 through 183, after the 16-byte header, 32-byte owner, 128 bytes of order keys and four-byte seat. Require all four bytes to be zero for every view. Stop the upgrade if any view cannot be inspected or has a nonzero byte.

Before enabling signed owner actions on the rollup that will run them, run `make rehearsal-owner-actions` on the rehearsal at the program id it will use. Its step "proof with one flipped signature byte" sends the correct text with one signature byte changed and must PASS, meaning the Ed25519 check refused it at instruction 0. If it FAILs because the send was accepted, that rollup does not verify precompile signatures: do not enable signed owner actions.
## 3. Keys

Create the keys before anything needs them, so you back them up before they hold anything. `.keys` stays on this machine and its backup is offline.

```sh
mkdir -p .keys && chmod 700 .keys
solana-keygen new --no-bip39-passphrase --outfile .keys/mainnet-program.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-admin.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-deployer.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-buffer.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-gate.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-keeper.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-crank.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-oracle.json
(umask 077; openssl rand -hex 32 > .keys/mainnet-maker-seed)
node -e '
const { Keypair } = require("@solana/web3.js");
const { readFileSync, writeFileSync } = require("fs");
const seed = Buffer.from(readFileSync(".keys/mainnet-maker-seed", "utf8").trim(), "hex");
const key = Keypair.fromSeed(seed);
writeFileSync(".keys/mainnet-maker.json", JSON.stringify(Array.from(key.secretKey)), { mode: 0o600, flag: "wx" });
console.log("maker address", key.publicKey.toBase58());
'
ID=$(solana-keygen pubkey .keys/mainnet-program.json)
echo "program id $ID"
```

The program key prints a seed phrase once: write it on paper, keep two copies offline, and clear the terminal's scrollback. Then:

| File (in `.keys`)                     | What it does                                                                          | Holds                                                    | Keep                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `mainnet-program.json`                | its public key is the program id, and the program is created with it                  | nothing                                                  | offline, two copies. It cannot be replaced: a new key is a new program id and a new deployment |
| `mainnet-admin.json`                  | the program's first upgrade authority and the exchange's first admin                   | 0.5 SOL and 700 USDC, just in time                       | until step 15, then drained and deleted                        |
| `mainnet-deployer.json`               | pays the deploy                                                                       | about 4.3 SOL, mostly refunded                           | delete after step 6; an upgrade uses a fresh one (see "Shipping an upgrade") |
| `mainnet-buffer.json`                 | the deploy's upload buffer, kept so a failed deploy resumes instead of paying twice    | about 3.3 SOL while an upload is half way                | delete after step 6                                            |
| `mainnet-gate.json`                   | co-signs every view opening; the gate service holds the same file                      | nothing                                                  | offline copy. A stolen one can use up the day's views; rotate it with `update_exchange` |
| `mainnet-keeper.json`                 | owns the keeper's seat                                                                | the keeper's deposit, as collateral in the rollup        | offline copy                                                   |
| `mainnet-crank.json`                  | signs `sync_price` and `sync_quote`                                                   | nothing; do not fund it                                  | offline copy                                                   |
| `mainnet-oracle.json`                 | named in the exchange, powerless on the mainnet build, which has no instruction that writes a price | nothing                                      | keep it here so setup never makes another; do not copy it to a server |
| `mainnet-maker-seed`, `mainnet-maker.json` | the house maker's seat: the seed is what the maker service holds, the file is what these commands sign with | the maker's capital, as collateral in the rollup | offline copy of the seed. Never replace it once the maker holds money |

Setup also writes `mainnet-sent-<program id>.json` (one-shot sends, so insurance cannot be sent twice), `mainnet-custody-nonce-USDC.json` and `mainnet-deployment.json` (public: the services read it). Back all of `.keys` up offline after every step that changes it. Losing the sent records can send insurance a second time, and insurance sent twice stays in the insurance seat for good.

Never use a key, seed, token or address that has been on a hosted service before. Generate everything for mainnet fresh, as above.

Create the Solana CLI's own settings for the deploy, so the private address never appears on a command line, and so no command can fall back to your default wallet (`Anchor.toml` names `~/.config/solana/id.json`, and a bare `solana program deploy` would pay with it and make it the upgrade authority):

```sh
(umask 077; printf 'json_rpc_url: "%s"\nwebsocket_url: ""\nkeypair_path: ".keys/mainnet-deployer.json"\ncommitment: confirmed\n' "$(cat .keys/mainnet-rpc-url)" > .keys/mainnet-solana-cli.yml)
```

## 4. Fund the two keys that hold money first

Send from your own wallet, to the addresses `solana-keygen pubkey .keys/mainnet-deployer.json` and `solana-keygen pubkey .keys/mainnet-admin.json` print:

- The deployer: the program's rent plus 1 SOL. Rent is the build's size times the cluster's rent per byte; after step 5, `solana -C .keys/mainnet-solana-cli.yml rent $(( $(wc -c < target/mainnet/$ID/noirwire_orderbook.so) + 45 ))` prints it. It is 3.26 SOL at the size of the rehearsal build (641,648 bytes, read from mainnet with `solana rent 641648 --url https://api.mainnet-beta.solana.com` on 2026-10-22), so fund the deployer about 4.3 SOL at that size; use the command's figure plus 1 SOL for your own build. The buffer's float returns to the deployer when the deploy ends.
- The admin: 0.5 SOL (the exchange's float is 0.2 SOL, the rest is fees) and `INSURANCE_USDC` plus `KEEPER_DEPOSIT` of USDC, 700 at the starting values. Send the USDC from your wallet app, which makes the token account.

Nothing else holds money yet. Do not fund the maker until step 11.

## 5. Build the program for its id

```sh
make check-mainnet DECLARED_ID=$ID
shasum -a 256 target/mainnet/$ID/noirwire_orderbook.so
```

Expect: `The mainnet build for <id> (<bytes> bytes) has sync_price and sync_quote and no instruction that writes a price.` Stop on any other message. Write the sha256 down with the commit. For a second check, build the same commit on another machine and compare the sha256. The build is one file: copy that exact file to every host that needs it, never rebuild it for them.

If a `noirwire_orderbook-keypair.json` sits beside the program file in `target/mainnet/$ID`, delete it. The deploy below names the program's key explicitly, but nothing should leave a second one lying there.

## 6. Deploy

```sh
solana -C .keys/mainnet-solana-cli.yml program deploy target/mainnet/$ID/noirwire_orderbook.so \
  --keypair .keys/mainnet-deployer.json \
  --program-id .keys/mainnet-program.json \
  --upgrade-authority .keys/mainnet-admin.json \
  --buffer .keys/mainnet-buffer.json \
  --max-sign-attempts 100 \
  --with-compute-unit-price 10000
```

Add `--use-rpc` only if your RPC plan takes write transactions at this volume (the provider says; a plan that does not will refuse them). The upload is about 700 transactions.

Expect: `Program Id: <your id>`. Stop if the id differs: nothing may be done with a program at another address.

If the upload stops half way, run the same command again: the kept buffer resumes it. To give up and take the SOL back: `solana -C .keys/mainnet-solana-cli.yml program show --buffers`, then `solana -C .keys/mainnet-solana-cli.yml program close --buffers`.

When it ends, `solana -C .keys/mainnet-solana-cli.yml program show $ID` must name the admin key's address as `Authority`. Then delete the two files the deploy used up:

```sh
rm .keys/mainnet-buffer.json .keys/mainnet-deployer.json
```

## 7. Check what is deployed

```sh
make mainnet-status MAINNET_PROGRAM_ID=$ID
```

Expect the line `program bytes` to say `the build at .../target/mainnet/<id>/noirwire_orderbook.so`, the `upgrade authority` to be the admin key's address, and the exchange to be `not set up`. If `program bytes` says `NOT THE BUILD`, stop: what is on mainnet is not what you checked. Every later mainnet command makes this same check before it sends.

## 8. Set up the exchange

```sh
make mainnet-setup MAINNET_PROGRAM_ID=$ID INSURANCE_USDC=500 KEEPER_DEPOSIT=200 INSURANCE_FIRST_SEND=yes
```

`INSURANCE_USDC` has no default on mainnet: without it (and with no insurance recorded) setup refuses. `INSURANCE_FIRST_SEND=yes` is needed on this first run only: the hosted rollup does not serve the custody token account, so nothing can show whether insurance was funded already, and the run asks you to say that no copy of these keys has funded it. Look at the admin's transactions first, answer yes on this one run, and never keep it in your shell or in later lines (once insurance is sent, the record with the keys stops the question). If a step of this run says `sync_price` or `sync_quote` was refused as "too old", start `make mainnet-crank MAINNET_PROGRAM_ID=$ID` on the launch machine in a second terminal, wait until it logs a `synced` round for market 0 and the USDC guard, stop it with Ctrl-C (the server's crank takes over in step 9) and run setup again.

The run ends at the mark check, which prints the mark, the reference and the cover and, because the hosted rollup does not serve custody, one `CAVEAT` line that the cover is sized from the insurance funded and that a resume will need `INSURANCE_HELD`. That caveat is not a failure: the run goes on and prints the description. If the mark check finds the market would be refused (a stale mark, a guard not passing, a shortfall, a cover under the cap) it says so in one line and still exits 0 without opening anything.

It does, in order, each step only if it is not done: the exchange at 5 new views a day, the USDC token, the ledger, SOL-PERP bound to Pyth, the USDC guard, the first marks, funding, insurance, and the keeper's view opened and its seat taken by its first deposit. Each step prints `step: <name>`. It prints the deployment description as JSON at the end, and keeps it in `.keys/mainnet-deployment.json`. It leaves SOL-PERP reduce-only.

It is safe to run again. If a run stops, say after sending insurance, it tells you which record is pending and the answer to give: `INSURANCE_SENT=landed:<id>` if the transaction landed, `lost:<id>` if it did not. Look at the chain before answering; a wrong `lost` sends insurance twice. The same applies to `FUNDING_SENT`, `KEEPER_SEAT_SENT` and `KEEPER_DEPOSIT_SENT`.

Back up `.keys` offline now.

## 9. Start the crank and the keeper

The server is configured and updated by the infra repository: put the crank key, the keeper key, the gate key, the maker seed and the private RPC addresses in its secrets; set the program id, the rollup address, and the validator (the keeper needs no seat count: it sweeps the exchange's seat capacity, read from the exchange); point it at the program file `target/mainnet/$ID/noirwire_orderbook.so` and the deployment description `.keys/mainnet-deployment.json`; pin the order book commit to `$COMMIT`. Its README has the exact names. Then, from the infra repository:

```sh
make deploy
make status
make logs SERVICE=crank
make logs SERVICE=keeper
```

Expect the crank and the keeper healthy. The services that serve users stay unhealthy until the maker's seat is open and funded (step 11), so a first `make deploy` may end with a timeout on those only; run it again after step 11.

In the crank's log expect, once a round, each source's name, the age of its newest observation (the rollup's clock minus its publish time), what came of the round, and the market's status and price health or the guard's state. The first rounds must send `sync_price` and `sync_quote` successfully. In the keeper's log expect one line per sweep, and a line each time the table has grown (the keeper reads the seat capacity from the exchange every sweep).

Both processes exit non-zero after a run of failed rounds (`CRANK_GIVE_UP`, `KEEPER_GIVE_UP`, 6 by default) and the supervisor restarts them and tells your ntfy topic. Set `HEALTHCHECK_URL` for a dead-man's switch outside the server (a ping after each good round or sweep). The ping means healthy, not only alive: it is held back while an `ALERT` stands (the keeper's margin alert, a position the keeper could not close, the crank's confidence incident), as well as after a failed round or sweep, so the switch rings for those too. Alert the switch's contact the way you alert for a crash.

With one server there is one crank. `SECURITY.md` asks for a second, independent one on another provider, and the image below is for that. A launch without it fails safe, not loud: a market nobody syncs goes stale and refuses orders that add risk, but it stops being priced until the crank is back. Add the second one as soon as you can, and watch the dead-man's switch until you do.

## 10. Soak the price source

Before any money beyond the insurance and the keeper's deposit goes in, let the crank run for several hours (at least 6, across a busy hour of the market), and read how old each observation is when the rollup sees it:

```sh
make logs SERVICE=crank LINES=5000
```

The ages decide `max_age`, which the launch holds at 90 seconds (and `max_age_liquidation` at 180) until measured. Write down the largest age and a typical one. Stop if ages come near 90 seconds, or if rounds fail: do not go on until you know why, and tell MagicBlock what you saw. Also check that the keeper's sweeps are running and none ended "stale price".

## 11. The house maker's seat, the dust round trip, then the capital

```sh
make mainnet-seat MAINNET_PROGRAM_ID=$ID SEAT=show
make mainnet-seat MAINNET_PROGRAM_ID=$ID SEAT=open
```

`show` prints the maker's address and that it has no view. `open` is signed by the gate key together with the maker's key and creates the maker's view; it holds no seat yet. The maker's seat is taken by its first deposit, below, at whichever index the table hands out.

Prove the way out with dust before any real amount goes in. Send the maker's address 1 USDC and 0.05 SOL from your wallet, then:

```sh
make mainnet-round-trip MAINNET_PROGRAM_ID=$ID KEYFILE=.keys/mainnet-maker.json AMOUNT=0.01
```

It moves 0.01 USDC from Solana into the rollup, deposits it to the maker (which takes the maker's seat, so the amount must be at least the exchange's minimum seat deposit, 0 unless you set one), withdraws it from the seat (which leaves it empty and gives the seat back, so the real deposit below takes a seat again), withdraws it from the seat, sends it on to the maker's USDC account on Solana, prints every signature and both balances, and fails unless the maker ends with at least what it started with. Write the signatures down.

Stop here if it fails. The tokens are not lost: `make mainnet-exit ... KEYFILE=.keys/mainnet-maker.json AMOUNT=0.01 FROM=rollup` finishes a run whose second step failed, and `METHOD=undelegate` is the older two-step route (it sends the owner's whole balance in the rollup). Until one of them completes on mainnet, the maker stays unfunded.

Then fund the maker. Send the maker's address 1,000 USDC and 0.05 SOL, then:

```sh
make mainnet-seat MAINNET_PROGRAM_ID=$ID SEAT=deposit AMOUNT=1000
make mainnet-seat MAINNET_PROGRAM_ID=$ID SEAT=show
```

Run `make deploy` in the infra repository again: the maker service becomes healthy once the seat is funded. The market is reduce-only until step 14, so the maker's quotes are refused until then: read `make logs SERVICE=sim`, and `make stop-maker` there if it does anything but wait.

## 12. The access lists

The market starts open to every seat. For an invite-only launch, list who may make and who may take, then switch the lists on over the empty book. The market is still reduce-only, so no order is resting.

```sh
make mainnet-access MAINNET_PROGRAM_ID=$ID ACCESS=seat SEAT_OWNER=<maker address> MAKER_MARKETS=0 TAKER_MARKETS=none BLOCKED=no
make mainnet-access MAINNET_PROGRAM_ID=$ID ACCESS=market MARKET=0 MAKERS=on TAKERS=on
make mainnet-access MAINNET_PROGRAM_ID=$ID ACCESS=show
```

For each invited trader whose view is already open, with the owner key from the gate's records (listing an owner who holds no seat takes one for them, and a listed seat is pinned: no sweep ever gives it back):

```sh
make mainnet-access MAINNET_PROGRAM_ID=$ID ACCESS=seat SEAT_OWNER=<owner key> MAKER_MARKETS=none TAKER_MARKETS=0 BLOCKED=no
```

Each call is simulated first, and sends nothing if it would fail (for example for an owner with no view). A seat's lists are sealed: they are never read back, so keep your own record of who you listed.

What this means for an invited user: with the maker list on, an order that could rest (a limit or post-only order that is not reduce-only) is refused for anyone but the maker (`MakerNotListed`). Invited users trade with market or immediate-or-cancel orders, and reduce-only orders of any kind. The liquidation keeper needs no listing.

Do not list an owner who may never trade: listing takes a seat for them, and a view that has held a seat cannot be closed as unused. After step 15 the same lists are set from the console's access actions.

## 13. Move the upgrade authority to the multisig

First confirm, in the multisig's own app, its signers, its threshold and its time lock, and copy the address of its vault, the address that signs for it. Nothing on chain proves a threshold, so this is the one place it is checked. Then:

```sh
make mainnet-upgrade-authority MAINNET_PROGRAM_ID=$ID MULTISIG=<vault address>
```

It refuses an address on the curve (a multisig's vault never is; such an address is a signer's key or a typo; `MULTISIG_IS_A_KEY=yes` overrides, only if a plain key is truly meant) and prints the address on a line of its own to compare, character by character, with the multisig's app through a second channel. It sends nothing. It prints the exact `solana program set-upgrade-authority` command, signed by the admin key, for you to run as printed (it uses the public RPC, so no key is in it). Run it, then run the make target again:

```sh
make mainnet-upgrade-authority MAINNET_PROGRAM_ID=$ID MULTISIG=<vault address>
```

Expect it to say the authority is the multisig's vault. Stop if it does not. Then `make mainnet-status MAINNET_PROGRAM_ID=$ID` shows the upgrade authority too.

**Without a multisig: a dedicated upgrade key.** If there is no time for a multisig at launch, the upgrade authority can be a dedicated hot key, different from the admin (at this step the admin is still the disk key `.keys/mainnet-admin.json`; the hardware wallet takes the role at the handover). Generate it on a machine that is not the server (`solana-keygen new --no-bip39-passphrase --outfile <path>`), keep it only encrypted and offline (an encrypted disk image or USB, never on the server or in the infra secrets), and fund it with just enough SOL for upgrade fees. Hand over with the same target and the explicit override. The on-curve check catches only a vault or program address pasted by mistake; it never catches a typo of a key, since a mistyped key is still on the curve. What catches a typo here is the printed command: with the override it drops `--skip-new-upgrade-authority-signer-check` and names the new key's file as `--new-upgrade-authority`, so `solana` makes that key co-sign and the authority becomes the key you hold, never an address you retyped. Replace the placeholder in the printed command with the real path of the key file, and check the target's last line afterwards says the authority is the address you meant:

```sh
make mainnet-upgrade-authority MAINNET_PROGRAM_ID=$ID MULTISIG=<the upgrade key's public address> MULTISIG_IS_A_KEY=yes
```

Run the printed command, then run the target again until it says the authority is that key. The resume check only requires the admin and the upgrade authority to differ. Whoever holds this key can replace the program and take everything, so the market stays as small as the team could make good. Moving to a multisig later is one command (`solana program set-upgrade-authority`, signed by this key) and is the first thing to do once there is time; with this key, "Shipping an upgrade or a hotfix" below has a variant that signs with it directly (steps 7 and 8), with no time lock.

No signer ever signs a transaction ahead of time against a durable nonce: such a transaction never expires. Every multisig transaction is built, checked from its decoded instructions and signed when it is to be sent.

## 14. Resume the market

The resume run signs as the admin, so it runs now, while the admin key on this machine is still the admin and the admin is no longer the upgrade authority. It is the last step the disk key takes for setup; step 15's `propose-admin` is signed with it too.

First look without opening anything:

```sh
make mainnet-setup MAINNET_PROGRAM_ID=$ID INSURANCE_USDC=500 KEEPER_DEPOSIT=200
```

It prints the mark beside the median of Coinbase, Kraken and Bitstamp's SOL/USD prices and what insurance covers at that mark, with the `CAVEAT` line of step 8 (the cover is sized from the insurance funded here), and one line `A resume would be refused now: ...` if the mark is older than the market's max price age, the USDC guard is not passing, the market is not healthy, a shortfall is recorded, the two prices differ by more than 1%, or the open interest cap is not covered at the live mark. If it is not covered, that line names the cap to lower to; lower it, and the position cap with it (`make mainnet-update-market MAINNET_PROGRAM_ID=$ID OPEN_INTEREST_CAP=<lots> POSITION_CAP=<lots> APPLY=yes`; without `APPLY=yes` it only shows the change), then run the line above again.


Before you give the yes, check each of these yourself:

- The keeper is running and its seat is funded (the resume run checks both), and the maker service is up (`make status` in the infra repository).
- The upgrade authority is the multisig, with the threshold you confirmed.
- The maker is funded and listed, the lists are on (step 12), and the soak numbers are written down.
- The crank's log is clean.

Then:

```sh
make mainnet-setup MAINNET_PROGRAM_ID=$ID INSURANCE_USDC=500 KEEPER_DEPOSIT=200 KEEPER_EVERY=1 RESUME_MARKET=yes
```

On the hosted rollup the custody balance cannot be read: it does not serve the custody token account, and the delegated custody's copy on Solana is stale. Nothing is read as zero. The resume run refuses, saying so, until you give it the insurance the exchange holds: read the insurance seat's balance from the admin console (the exchange's insurance figure, in whole USDC) and add `INSURANCE_HELD=<whole USDC>` to the line above. The cover is then sized from the lesser of the insurance funded and that figure, and the run prints a caveat that custody could not be read. Read the figure from the console just before you run it.

`KEEPER_EVERY` must match the keeper's, because the run watches the keeper's view for a write for as long as the keeper can go between two (its pause, plus a minute of backoff, plus 30 seconds). Expect `SOL-PERP resumed at a mark of <price>.` If the run is refused for any reason (a stale mark, the guard, a shortfall, the cover, the keeper, its collateral) it exits non-zero with the reason and nothing was opened: fix what it names. The keeper's collateral must also be at least what one takeover of a seat at the position cap needs at the initial margin at the live mark (position cap in lots times the mark times `im_bps`, over 10,000; 111 USDC at a mark of 150 and the launch's caps, 222 USDC at 300), since the keeper's whole job is that takeover; deposit more (`KEEPER_DEPOSIT` raised, or step "Topping up the keeper's seat") if it is under.

## 15. Hand the admin role to the hardware wallet

```sh
make mainnet-propose-admin MAINNET_PROGRAM_ID=$ID NEW_ADMIN=<hardware wallet address>
```

It refuses a key that cannot sign (a multisig's vault), the current admin and the upgrade authority. Then, as it prints:

1. Check the address with the person who holds the wallet, through a second channel, not this terminal.
2. In the admin console, connect that wallet, open the admin actions, choose Accept admin, and check the decoded instruction on the device before signing.
3. Run `make mainnet-status MAINNET_PROGRAM_ID=$ID`. The admin must be the hardware wallet's address and no admin pending.

From now on the admin key on this machine cannot send as admin: the console is the admin. `mainnet-propose-admin`, `mainnet-update-market` and `mainnet-access` stop with a message saying so, and the exchange would refuse the admin sends of `mainnet-setup`, so do not run it again. Move what is left in `mainnet-admin.json` to your own wallet, then delete the file. Back `.keys` up one last time.

Rehearse the console's admin actions (pause, reduce-only, accepting an admin) with the real wallet and the second device on the devnet rehearsal before launch day. Note any blind-signing setting the device needs.

## 16. Open to the invited

Only now point the terminal at the market and let the gate open views. The gate opens views only after its own check of who is asking, with a limit per person, and declines places it does not serve (the United States and Ontario among them). The exchange opens at most 5 new views a day. A view holds no seat: the trader's first collateral deposit takes one.

For each new trader: take the owner key from the gate's records, list it from the console's access actions (taker list for market 0), which takes the seat if the trader has not deposited yet, and keep a record. The keeper needs nothing when the invited list grows: it sweeps the exchange's whole seat capacity. Watch the table instead (see "Watching the seat table").

The first hour, keep these open and look at them every few minutes:

- `make status` in the infra repository: every service healthy, no restarts.
- `make mainnet-status MAINNET_PROGRAM_ID=$ID`: SOL-PERP `status 0` (active; 1 is paused, 2 reduce-only), shortfall 0, the price a few seconds old, the USDC guard passing, seats opened as you expect, custody matching what you expect (the `token 0` line ends with the custody balance held, or `not readable here` on the hosted rollup, where you read it from the admin console instead).
- The crank and keeper logs: any `ALERT` line says what to do.
- Your ntfy topic.

## Day to day

### Pausing: who and how

There are three levers, from gentlest to hardest. Pull the gentlest that stops the problem.

| Level | What it does                                                                     | Who                                               | How                                                                                                  |
| ----- | -------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1     | Stops the house maker: cancels every quote and quotes nothing                    | the operator, from the infra repository           | `make stop-maker` there is the full stop: it cancels every quote and quotes nothing. `MODE=reduce` is the soft stop: it also pulls every quote and places none, and only a flatten trades the maker's own position down, so it leaves no side for users to close against. `MODE=resume` starts it again. If it fails: `make stop SERVICE=sim` |
| 2     | Puts SOL-PERP in reduce-only status: no new risk, withdrawals go on; exits stop once the maker's resting quotes expire (about 20 s), until the admin resumes | whoever holds the admin hardware wallet           | the console's admin actions, restrict market. Resume only after `make mainnet-markcheck` says a resume is safe, from the console |
| 3     | Pauses the exchange or the market: no orders, closing orders included            | the same                                          | the console's pause action. The last resort; read `RULES.md` section 3 (check 1) and section 9 first  |

Before step 15 the disk key is the admin, and there is no `mainnet-*` target that pauses. The market is reduce-only until step 14, which is the pause you have. After step 14 and before step 15, use level 1 and do step 15 at once.

Level 2 is not a way to keep users exiting. A reduce-only order never rests, so a user can close only against quotes already resting, and the maker's expire within its quote life (the 10 s requote interval plus a 10 s margin, so about 20 s), and it places none while the market is reduce-only. Once those expire, exits stop until the admin resumes the market. Resuming quickly is the exit.

Decide before launch who else can reach level 2: only the admin hardware wallet's holder can. If that is one person, say so in your own plan and keep the second device somewhere that person can get to.

### Raising caps in steps

- The open interest cap and the position cap: the market is sized so that insurance covers the open interest cap at the live mark (`RULES.md` section 12): `open_interest_cap <= insurance / (mark * (gap - penalty))`, with a 20% gap and a 2% penalty. Raise insurance first (the console's fund insurance), then the caps (the console's update market). `make mainnet-update-market` only lowers a cap or raises it back to the launch's own figures, and only while insurance covers it, sized as the mark check sizes it (funded insurance, lowered by public custody and by `INSURANCE_HELD`); on the hosted rollup a raise needs `INSURANCE_HELD=<whole USDC from the console>` and is refused without it, while a lowering never needs it. That is deliberate.
- Re-check what insurance covers whenever it falls or the mark moves far from where the caps were sized. The tooling computes it from the USDC the launch funded, lowered where public custody shows less beyond the keeper's seat; it cannot see a deficit insurance paid, because the insurance seat is sealed. After an incident that paid deficits, read the insurance seat's balance from the console and give it to the checks as `INSURANCE_HELD=<whole USDC>` (on `make mainnet-markcheck` and on a resume run of `make mainnet-setup`). It can only lower the figure the cover is sized from, never raise it, and a figure at or above what the tooling already bounds changes nothing.
- `max_seats_per_day` (it counts views opened): raise it from the console only as the invited list grows.
- Loosening a limit needs a week of measured data. Tightening can happen at any time.

### Watching the seat table

The table starts at 2,048 seats and is grown in place from the console's `extend_ledger` (33 seats a call, batched into transactions, 9,728 lamports of rent a seat). Grow it ahead of need: 8,192 seats at launch, then up to 12,288, which is as far as this build lets it go (`extend_ledger` refuses past it with `LedgerTooLarge`, because `reconcile_shortfall` reads the whole table in one call). Going beyond 12,288 needs a later upgrade of that instruction; the layout itself holds 34,492 seats and the growth needs no relayout. From 8,192 to 12,288 adds about 39.8 million lamports of rent (0.04 SOL), paid by the exchange, so keep its float above the alert; top it up with `make mainnet-float-topup MAINNET_PROGRAM_ID=$ID KEYFILE=<a funded wallet's key file> AMOUNT=<SOL, 5 at the most>`.

Nobody can read the sealed ledger, so gauge occupancy from the views the gate has opened less those closed (the gate exposes the count): every seat has a view, so that is an upper bound. Alert at 70% of `seat_capacity`; then grow the table, lower the gate's rate, or raise `min_seat_deposit` from the console (`update_exchange`). A full table refuses only a deposit that would take a seat (`SeatTableFull`); existing traders are not affected. The keeper's release sweep (`RELEASE_EVERY_MS`, ten minutes by default, in ranges of `RELEASE_RANGE` seats) gives back seats that are empty and unpinned. While the taker list is on, every invited trader is pinned and never recycles, so switch it off at the public opening.

### Checking the mark before a resume

Every resume, at launch or after an incident, rests on the same check. Before step 15 it is part of `make mainnet-setup` (step 14 and the `RESTORE=resume` runs). After step 15 the admin key is gone from this machine, setup cannot run, and the resume is given from the console, so the check has a target of its own that needs no admin key:

```sh
make mainnet-markcheck MAINNET_PROGRAM_ID=$ID KEEPER_EVERY=1
```

It reads and prints: the market's status, the mark with its age against the market's max price age (a mark older than it is `TOO OLD` and a resume is not safe), the USDC guard's state, the market's price health and every recorded shortfall (any of them not clean is a no), the median of Coinbase, Kraken and Bitstamp's prices (and Pyth Pro's, given a token), the gap between them, what insurance covers at that mark against the open interest cap, who the upgrade authority is, and the keeper's seat, recorded deposit and liveness (it watches the keeper's view for a write, for as long as a running keeper can go between two, so give it the keeper's `KEEPER_EVERY`; the keeper's key file `mainnet-keeper.json` must be in `.keys` on this machine, or it says the keeper cannot be confirmed). On the hosted rollup it cannot read the custody balance (the rollup does not serve the custody token account), so unless you give it `INSURANCE_HELD=<whole USDC>`, read from the admin console's insurance seat balance, its last line says a resume is not safe, and says why; run it again with the figure (`make mainnet-markcheck MAINNET_PROGRAM_ID=$ID KEEPER_EVERY=1 INSURANCE_HELD=<whole USDC>`). With the figure it sizes the cover from the lesser of the insurance funded and that figure, and prints a caveat that custody could not be read. A keeper funded before the deployment kept deposit records shows "no deposit record" and the collateral its view holds; that collateral counts as funded. Its last line says plainly whether a resume is safe by what it read. It sends nothing and refuses nothing: the answer is yours to act on. Resume from the console only after it says a resume is safe, and run it again just before you sign, since the exchanges move.

### Topping up the keeper's seat

Every takeover that loses money shrinks the keeper's collateral for good. When the keeper's log prints `ALERT ... the keeper's margin cannot carry its position`, or the mark check shows its collateral low, deposit more:

```sh
make mainnet-keeper-deposit MAINNET_PROGRAM_ID=$ID KEYFILE=<a funded wallet's key file> AMOUNT=<whole USDC>
```

The wallet is any one that holds the USDC on Solana (with a little SOL for the move): not the admin's, so this works after step 15, and not the keeper's. It moves the USDC into the rollup and deposits it as collateral to the keeper's seat; nothing here can take anything out of the seat. The keeper's address is the one of `.keys/mainnet-keeper.json`, or `KEEPER=<its public key>` (`solana-keygen pubkey` on the server's key file) where that file is not on this machine. There is no cap to raise: the only ceiling on a deposit is the fixed technical one of RULES 11, far above any real balance. The keeper shows the new collateral after its next sweep, and takes the seat that raised the alert on the first sweep its margin can carry. Where `.keys/mainnet-deployment.json` records the keeper's deposit, the command adds the amount to it. Do not run it while a setup run is going.

After this command the recorded total exceeds the `KEEPER_DEPOSIT` of your earlier setup lines, and a later `make mainnet-setup` refuses a lower figure: pass the new total as `KEEPER_DEPOSIT` (the old figure plus what you added, in whole USDC) on every later setup run.

Before step 15 you can do the same with `KEEPER_DEPOSIT` raised on `make mainnet-setup`, which deposits the difference from the admin's own USDC. Use one way for one top-up, never both.

### A position the keeper cannot close

A position the keeper holds that is under the market's minimum order size or notional prints a `market N: ALERT, the keeper holds ... lots` line on every sweep and holds back the healthy ping while it stands. Its exposure is small (under one minimum order) but real, and nothing closes it automatically. Routes, in order:

1. Wait for a takeover on the other side: the keeper takes seats blind, and a takeover that offsets the position clears the alert on the next sweep.
2. Offset it by hand. There is no one-command tool for this. With the keeper stopped (`make stop SERVICE=keeper` in the infra repository, so nothing else rotates its order keys), the market active, and the keeper's seat listed as a taker for market 0 if the taker list is on (`make mainnet-access ... ACCESS=seat SEAT_OWNER=<keeper> TAKER_MARKETS=0 ...`), use the SDK's `TraderClient` with `.keys/mainnet-keeper.json` (as `signedIn` in `ops/keeper.ts` does) to send a market order on the opposite side of size `position + minimum order size`, so the seat ends on the other side with at least the minimum, then a reduce-only market order for what is left, which closes it. Start the keeper again and check the alert is gone. A market in reduce-only status or paused takes only reduce-only orders, which cannot do this.
3. If neither is possible, tell the invited users, keep the maker off the side that would grow it, and keep the alert standing: do not silence it.

A keeper that cannot save its order key checkpoint (the keeper-state folder is not writable) fails its sweeps, prints `ALERT: could not save the order key checkpoint ...` with how far the keys' index is from the 100,000 a restart's search gives up at, and exits after `KEEPER_GIVE_UP` failed sweeps: make the folder writable at once.

The keeper keeps no seat count. Each sweep it reads the exchange's seat capacity and sweeps every seat below it, so a table that grows is covered from the next sweep (the log says by how much it grew), and there is no value to set, lose or re-derive. Beside the sweep, and never holding it up, it sends `release_empty_seats` over the table every `RELEASE_EVERY_MS` in ranges of `RELEASE_RANGE` seats. Anyone may send that instruction, so a keeper that is down delays the recycling of empty seats and nothing else.

### Exiting a seat, and a response that was lost

`make mainnet-exit` and `make mainnet-round-trip` write each send down in `.keys/mainnet-exit-<owner>.json` before it is broadcast (the amount, the seat withdrawal, and the signature of each Solana transaction, derived from the signed bytes). Run again after any failure with the same `KEYFILE`, `AMOUNT` and `METHOD`: the run checks the record against the rollup balance and Solana before it builds anything, never withdraws from the seat twice for one exit, and carries on from what landed. A transaction that may still land makes it wait (until the block height it names has passed); a seat withdrawal whose outcome cannot be shown asks for `EXIT_SENT=landed:<id>` or `lost:<id>` after you have looked. A Solana send that any run saw as `processed` is marked so in the record and is never dropped on a later missing status, even after its blockhash has expired, because a node that lags can answer nothing for a transaction another node executed. It waits until it is confirmed or you answer `EXIT_SENT=landed:<signature>`, which needs the signature shown as confirmed or finalized on an explorer, or the owner's token account on Solana already holding the amount. There is no `lost` answer for it: only if the finalized chain has no trace of the signature and the owner's balances on both sides are unchanged, delete the record file by hand and run again. A different amount is refused while an unfinished exit is recorded. The round trip needs about 0.03 SOL in the owner's account (the move in and the exit), the exit itself about 0.01.

### Keys

- The gate key leaks: lower the seats a day (the console), then rotate the gate with `update_exchange` and replace the key in the gate service. A stolen gate key can open seats, up to the day's limit, and nothing else.
- The admin key or its device is in doubt: `propose_admin` from it to the second device's address, `accept_admin` from the console on the second device, checked through a second channel. Do it at once.
- Never replace the maker seed once the maker holds money: it is the seat. Flatten, withdraw inside the rollup, exit with `make mainnet-exit`, then switch.

## Incident checklist

Start every incident the same way: stop the maker (level 1), look, then decide. Write down the time and what you saw as you go.

| What you see                                                                | First action                                                                                                       | Then                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The crank prints `ALERT` or a market is dislocated, settling or `stale`     | Level 2 (reduce-only) from the console if the log says to                                                          | `make logs SERVICE=crank`; check the private RPC (replace `.keys/mainnet-rpc-url`'s address in the infra secrets and `make restart SERVICE=crank`); resume only after `make mainnet-markcheck` says a resume is safe, from the console |
| The USDC guard is not passing (`make mainnet-status` says `NOT passing`)    | Level 2                                                                                                            | The guard fails closed: orders that add risk are refused. Wait for it to pass again; resume from the console after `make mainnet-markcheck` says a resume is safe |
| A market shows a shortfall above 0                                          | Level 2                                                                                                            | Collateral withdrawals are refused for everyone until it is covered (`RULES.md` section 12a). Tell the users, fund insurance from the console, follow section 12a |
| The keeper is down or its sweeps end `stale price`                          | `make logs SERVICE=keeper`, `make restart SERVICE=keeper`                                                          | Nobody is liquidating while it is down. If it does not come back within minutes, Level 2. An `ALERT` about its own margin says to fund its seat: `make mainnet-keeper-deposit` (below), from any funded wallet |
| The keeper holds a position it could not close (`ALERT`)                    | Watch it: it is retried every sweep                                                                                | If it lasts, close it from the keeper's seat by hand, or get orders onto that side of the book (the maker quoting it helps)                                |
| Market data, the gate or the maker misbehave                                | Level 1                                                                                                            | `make logs SERVICE=sim`; `MODE=reduce` pulls the quotes and leaves nothing for users to close against                                                                                             |
| The rollup or its endpoint is down                                          | Do not change anything. Tell the users                                                                             | The crank and keeper back off and keep trying. Funds sit in the rollup: nothing in this repository can move them without it                               |
| The gate key is stolen or views open that you did not expect                | Lower the views a day to 0 from the console                                                                        | Rotate the gate (above); list nobody new until it is replaced                                                                                              |
| The admin key or its device is in doubt                                     | Level 1, then hand the role over (above)                                                                           | Do not sign anything on the device in doubt except the `propose_admin`                                                                                    |
| The upgrade authority's multisig is in doubt (a signer's device)            | Level 2                                                                                                            | Change the signers in the multisig's app. Until the program is final, the multisig is what can replace it                                                  |
| You suspect a bug                                                           | Level 2, then level 3                                                                                              | Do not guess: a program that cannot be explained is not resumed. Reproduce on the rehearsal (devnet) with the same build before anything is changed         |

Afterwards: `make mainnet-status MAINNET_PROGRAM_ID=$ID`, the logs of the crank and keeper, and the console, all agree and are clean; resume only after `make mainnet-markcheck` says a resume is safe; note what happened, what you did and what you changed.

## Shipping an upgrade or a hotfix

An upgrade replaces the program, so it goes through whatever holds the upgrade authority and nothing shorter: the multisig, or the dedicated upgrade key if that is the path taken (steps 7 and 8 differ; the rest is the same). The program on mainnet must stay byte for byte the build the crank and keeper are given, so their file changes with it.

1. Level 2 (reduce-only) first, from the console. With a multisig, a hotfix waits for its time lock like any upgrade, and the market stays reduce-only meanwhile. With the upgrade key there is no time lock: the upgrade lands as soon as you send it, so the market is reduce-only only for as long as you take, and a stolen key upgrades just as fast.
2. Build at the tagged commit: `git checkout --detach <commit>`, a clean tree, then `make check`, `make unit`, `make test-audit`, and `make check-mainnet DECLARED_ID=$ID`. Record the sha256 of `target/mainnet/$ID/noirwire_orderbook.so`, and compare it with a build on a second machine.
3. Prove it reads the state the deployed build left: `make test-upgrade UPGRADE_FROM=<the deployed commit's target/deploy/noirwire_orderbook.so, from make build at that commit>`. An upgrade that changes the account layout is not applied over a running exchange: it goes with the migration of "Moving an exchange to the current ledger layout" below, with trading paused, and the proof here must include the copy.
4. Keep the program file you are replacing, and its sha256, as the way back. An upgrade whose build is larger than the program account needs the account extended first, or the deploy fails: `solana -C .keys/mainnet-solana-cli.yml program show $ID` prints the account's `Data Length`, to compare with `wc -c < target/mainnet/$ID/noirwire_orderbook.so`; when the build is larger, run `solana -C .keys/mainnet-solana-cli.yml program extend $ID <bytes> --keypair <the upgrade key file>`, with at least the difference and some headroom: the upgrade key signs and pays, and with a multisig the extend goes through it like the upgrade. The signer pays the rent of the added bytes.
5. Step 6 deleted the deployer key, so make a fresh deployer key and a fresh buffer key, point the CLI settings at the new deployer, and fund the deployer as in step 4 (the new build's rent from `solana rent`, plus 1 SOL; the rent comes back to its address when the multisig's upgrade spills the buffer). Then write the new program to a buffer:

   ```sh
   solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-deployer.json
   (umask 077; printf 'json_rpc_url: "%s"\nwebsocket_url: ""\nkeypair_path: ".keys/mainnet-deployer.json"\ncommitment: confirmed\n' "$(cat .keys/mainnet-rpc-url)" > .keys/mainnet-solana-cli.yml)
   solana-keygen new --no-bip39-passphrase --silent --outfile .keys/mainnet-buffer.json
   solana -C .keys/mainnet-solana-cli.yml program write-buffer target/mainnet/$ID/noirwire_orderbook.so \
     --keypair .keys/mainnet-deployer.json --buffer .keys/mainnet-buffer.json \
     --max-sign-attempts 100 --with-compute-unit-price 10000
   ```

6. Check the buffer holds the build: `solana -C .keys/mainnet-solana-cli.yml program dump <buffer address> buffer.so`, then `shasum -a 256 buffer.so target/mainnet/$ID/noirwire_orderbook.so`. The two must match. Delete `buffer.so`.
7. With the upgrade key instead of a multisig: hand the buffer to that key with `solana -C .keys/mainnet-solana-cli.yml program set-buffer-authority <buffer address> --new-buffer-authority <the upgrade key's address> --keypair .keys/mainnet-deployer.json`, then go to step 8's variant. With a multisig: hand the buffer to the multisig: `solana -C .keys/mainnet-solana-cli.yml program set-buffer-authority <buffer address> --new-buffer-authority <vault address> --keypair .keys/mainnet-deployer.json`.
8. In the multisig's app, build the upgrade of `$ID` from that buffer, with the deployer's address as the spill. Every signer checks the decoded instruction, the program id, the buffer and its sha256 before signing. The time lock runs. With the upgrade key, deploy from the buffer yourself, signed by it, on the machine that holds the key: `solana -C .keys/mainnet-solana-cli.yml program deploy --program-id $ID --buffer <buffer address> --upgrade-authority <upgrade key file> --keypair .keys/mainnet-deployer.json` (the spill goes to the deployer's address), then go straight to step 9, and to the reduce-only checks of steps 10 and 11.
9. When the upgrade lands, put the new build where the crank and keeper read it and update them at once: in the infra repository, point it at the new program file and the new commit, then `make deploy`. The crank and keeper exit while the program on mainnet is not their build, and they will until this is done.
10. Check: `make mainnet-status MAINNET_PROGRAM_ID=$ID` says `program bytes   the build at ...` for the new file; the crank is syncing; the keeper is sweeping; `ACCESS=show` shows the lists as they were. How soon the rollup serves an upgraded program is for MagicBlock to say: get their answer before the first upgrade and write it here, and read the market's counters after it (they must not have reset).
11. Run `make mainnet-markcheck MAINNET_PROGRAM_ID=$ID`, and resume from the console only if it says a resume is safe. Delete the buffer key.

To make the program final, so it can never be replaced, the multisig sets the upgrade authority to none. That cannot be undone; do it only when the program has run long enough that you will not need to change it.

## Moving an exchange to the current ledger layout

An exchange built with the older ledger (448-byte seats at `["ledger"]`) is moved onto the current one (304-byte seats at `["ledger-v2"]`) in one pause, without moving money. Every seat keeps its index, so books, views and order keys are untouched. The older program stays redeployable until the new ledger is live.

**Before the day.** The upgrade proof of "Shipping an upgrade or a hotfix", step 3, passed from the deployed commit, with its copy of the ledger. `make rehearsal-relayout` (and `make devnet-relayout` on devnet) passed twice on an exchange holding the old layout, with a funded maker and keeper, resting orders and a liquidatable position. The program buffer is written and checked. Every console action below was rehearsed with the hardware wallet, and the float top-up of the delegated exchange was proved on devnet, against the rehearsal deployment (`make rehearsal-float-topup`). The settings to carry: `min_seat_deposit` 0 (any positive collateral deposit takes a seat; raise it later only if dust seats pile up), views a day 1,000 with 1 per IP at the gate, and the taker list off at the public opening.

1. **Stop new views and the maker.** Turn the gate off. Cancel everything the house maker has resting (`make stop-maker` in the infra repository, or `cancel_all`), then stop it. The keeper keeps running. Check the maker has no resting orders.
2. **Record the before state.** Custody balances; for the founder's, the maker's and the keeper's view the snapshot (balances, positions, orders); the exchange's custody-cap values and the bytes at its layout position; the exchange's float, which must be at least 0.1 SOL (the new ledger and its growth to 8,192 seats cost 0.08 SOL). Save it to a file. A seat moves only if it holds at most 4 markets, and a seat that does not stops the copy until the previous program is put back: with 4 markets or fewer listed this cannot happen; with more, find every seat holding positions or resting orders in more than 4 and have it reduced before step 3.
3. **Pause and stop the keeper.** Console: `set_paused(true)`; then stop the keeper. Check the exchange reads paused.
4. **Extend the program account, then upgrade the program** from the buffer. The new mainnet build (`target/mainnet/$ID/noirwire_orderbook.so`) is 743,576 bytes and the live program account holds 712,448 bytes of program data (`solana program show $ID`, "Data Length"), so the account must grow by at least 31,128 bytes before the upgrade. Run `solana -C .keys/mainnet-solana-cli.yml program extend $ID 40000 --keypair <the upgrade key file>` (with a multisig, through it like the upgrade): 40,000 bytes leaves headroom and costs roughly 0.28 SOL of rent, paid by the signer. The devnet rehearsal ran this step the same way. Check `Data Length` grew. Then upgrade (steps 5 to 8 of the shipping procedure above; the services wait for step 10 here). Check the rollup serves the new program.
5. **`migrate_exchange`** from the console. The exchange now reads as migrating.
6. **Copy the ledger.** Console, in order: `create_relayout_ledger`; grow the new account to 622,640 bytes (60 grow steps in 2 transactions); `relayout_seats` with 256 seats a call, 8 calls; `finish_relayout`. Each call must succeed. `finish_relayout` compares both tables (seat count, collateral, every spot balance, each market's summed position, open lots and order count, and the free list) and fails with `RelayoutMismatch` on any difference, in which case nothing has switched. After it the exchange reads live with a capacity of 2,048 seats and its copy cursor back at 0.
7. **Grow to 8,192 seats.** Console: `extend_ledger`, 187 calls of 33 seats, about 7 transactions. Check the capacity reads 8,192 and the float fell by about 79.7 million lamports in all since step 6.
8. **Top up the float** to at least 1.25 SOL (8,000 views at 126,624 lamports is 1.01 SOL, plus the ledger and margin), with `make mainnet-float-topup MAINNET_PROGRAM_ID=$ID KEYFILE=<a funded wallet's key file> AMOUNT=<SOL, 5 at the most>`. One run sends at most 5 SOL, so send the amount in parts of 5 SOL or less. Any funded wallet will do, not only the admin's hardware wallet. The command sends MagicBlock's delegated lamports transfer, because SOL sent to the delegated exchange on Solana never reaches the rollup, and it fails unless the float on the rollup is seen at least the amount above where it started. That is a reading of the float, not proof of this transfer: a view opened meanwhile spends from the float and another credit adds to it. The gate is off from step 1, so no view opens here; run one top-up at a time and read the float back before going on. Topping up later, with the gate open, a timeout is not proof the credit is missing: read the float and the transfer account it names.
9. **Set the exchange.** Console `update_exchange`: `min_seat_deposit` and `max_seats_per_day`. Set the gate's rates in the infra repository's `gate_settings` to match (`GATE_SEATS_PER_DAY` to the same views a day, `GATE_SEATS_PER_IP_PER_DAY` 1), leaving `GATE_OPEN` off; they go out with step 10's deploy. Read both back. The program's figure caps the gate's from above, so a gate set higher opens no more.
10. **Deploy the services** built on the new client: crank, keeper, gate and maker (the sim), terminal, console, MCP. In the infra repository, `orderbook_commit` names the commit this program was built from, since the crank and keeper refuse to run beside any other build; `make deploy` then replaces both cranks, the keeper and the sim. The keeper no longer takes a seat count, so the infra repository carries no `keeper_seats`. Check all are healthy and the crank has synced a fresh mark.
11. **Verify while still paused.** `sync_view` for the maker and keeper (their operator keys) and for the founder (the terminal). Each snapshot must equal step 2.
12. **Unpause** (`set_paused(false)`) and start the keeper and the house maker. Run `make mainnet-markcheck MAINNET_PROGRAM_ID=$ID KEEPER_EVERY=1 INSURANCE_HELD=<whole USDC>` just before: the pause held liquidations while the price moved, so unpause only when its mark, USDC guard, shortfall and cover lines are clean. A browser tab that loaded the terminal before the upgrade still sends the previous layout, which the program refuses without changing anything; it works again once reloaded. The maker quotes, and the keeper's full sweep over 8,192 seats ends well inside `KEEPER_DEADLINE` (180 seconds).
13. **Smoke with a fresh wallet.** Open a view (no seat). If a minimum is set, a deposit below it is refused with `SeatDepositTooSmall` and nothing is taken. A deposit at the minimum takes a seat. Trade, flatten, withdraw everything: the view then holds no seat, an order is refused `NotSeated`, and a new deposit takes a seat again. A `release_empty_seats` sweep runs clean. Trigger the float alert once in a test.
14. **Open the gate** to the public, with the taker list off: `GATE_OPEN` on in `gate_settings`, then `make deploy` in the infra repository. Watch views a minute, float runway, sweep duration and `SeatTableFull` reports.

**Rollback.** `finish_relayout` is the point of no return. Before it succeeds, the new ledger is not ready, so every deposit, withdrawal, cancel and order is refused, and nothing anywhere has moved: put the previous program back (dumped and hash-checked before step 4) and restore the custody caps that `migrate_exchange` zeroed, from the values recorded in step 2, with the previous program's own instruction. The half-built new ledger costs about 0.02 SOL and is ignored by the previous program, which reads a different address. Once `finish_relayout` has succeeded, do not roll back. A paused exchange still lets a trader deposit, withdraw and cancel, so from that moment the new ledger can hold changes the old one never saw: a trader who withdrew on the new ledger would be credited again by the old one. From there every fix is forward, by a new program upgrade on the new ledger. `finish_relayout` refuses on any difference in the totals, so check step 2's record against what it compares before you send it.

**Growing later.** From 8,192, grow with `extend_ledger` as the seat table fills (see "Watching the seat table"), at most to 12,288 seats in this build. The release sweep runs from the keeper from step 12 on.

## Running the crank or the keeper from the image

The server of step 9 runs them for you. The image is for a crank or keeper somewhere else, on any container host: a second, independent crank on another provider is the usual case.

```sh
make image-amd64 IMAGE_TAG=$(git rev-parse --short=12 HEAD)    # or image-arm64
docker save noirwire-orderbook:<tag>-amd64 | ssh <host> docker load
```

Each key file must be owned by the user id the container runs as (`--user`, below) and have mode 0400 or 0600, and must be a regular file, not a symbolic link. The entrypoint refuses to start otherwise, and so does the process: a key mounted as root or as the host user is refused even at 0600, so `chown` it (and `chmod 0400`) on the host before mounting.

On the host, with the files mounted from a folder only that container's user can read:

```sh
docker run -d --name crank --init --restart unless-stopped --read-only \
  --user 10001:10001 \
  -e MAINNET_PROGRAM_ID=<program id> \
  -e ROLLUP_URL=<rollup address> \
  -e VALIDATOR=<validator> \
  -v /srv/noirwire/mainnet-crank.json:/keys/mainnet-crank.json:ro \
  -v /srv/noirwire/mainnet-deployment.json:/config/mainnet-deployment.json:ro \
  -v /srv/noirwire/mainnet-rpc-url:/config/mainnet-rpc-url:ro \
  -v /srv/noirwire/noirwire_orderbook.so:/program/noirwire_orderbook.so:ro \
  noirwire-orderbook:<tag>-amd64 crank
```

The keeper is the same with `keeper`, its own key file, and one more thing: it writes the places of its order keys next to its key, so `/keys` is a folder that user can write, and the key file is mounted into it read-only:

```sh
  -v /srv/noirwire/keeper-state:/keys \
  -v /srv/noirwire/mainnet-keeper.json:/keys/mainnet-keeper.json:ro \
```

Keep that folder across restarts: without it the keeper starts its search for its order keys from index 0, which stops working after about 100,000 rotations.

The base image is pinned by digest in the Dockerfile (`NODE_DIGEST`), so a build that will hold mainnet keys never takes a base nobody looked at. `make image-digest` prints the digest the tag names now; to take a newer base, read what changed, put the new digest in the Dockerfile and rebuild.

What is in the image: the client, the operator scripts and Node 26. What is not: any key, any `.env` file, anything under `target/`, any deployment description, any program build, any RPC address. `.dockerignore` is an allow list, and the Dockerfile copies only the client's and the scripts' sources.

### Environment

| Setting                          | Default in the image                    | Meaning                                                                                                              |
| -------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MAINNET_PROGRAM_ID`             | none, required                          | The program id it works for. The process refuses to send to mainnet without it                                       |
| `ROLLUP_URL`                     | none, required                          | The private rollup's address                                                                                         |
| `VALIDATOR`                      | none, required                          | The public key of the validator that runs that rollup                                                                |
| `SOLANA_URL`                     | read from `SOLANA_URL_FILE`             | The Solana RPC address. Set it only if you cannot mount the file; it then sits in the container's environment         |
| `SOLANA_URL_FILE`                | `/config/mainnet-rpc-url`               | The private RPC file: one line, the address. Never echoed                                                            |
| `KEYS_DIR`                       | `/keys`                                 | Holds the process's key as `<NETWORK>-crank.json` or `<NETWORK>-keeper.json`. The process stops if it is missing, so a new key is never made |
| `DEPLOYMENT`                     | `/config/mainnet-deployment.json`       | The description `make mainnet-setup` wrote. Required                                                                 |
| `BUILT_PROGRAM`                  | `/program/noirwire_orderbook.so`        | The build from `make check-mainnet`. The process sends only when the program on mainnet is that file, byte for byte  |
| `NETWORK`, `PROFILE`             | `mainnet`, `mainnet`                    | Name the key files and the settings. Leave them                                                                      |
| `GENESIS`                        | mainnet's genesis hash                  | The process stops if the chain it reaches has another genesis                                                        |
| `PUBLIC_SOLANA_URL`              | `https://api.mainnet-beta.solana.com`   | The public RPC the deployment names; never your private one                                                          |
| `CUSTODY`, `EXCHANGE_FLOAT_LAMPORTS` | `public`, `200000000`               | The launch's own values. Leave them                                                                                  |
| `PROGRAM_ID`, `PRIVATE_URL`, `DEPOSIT_URL` | the program id, `ROLLUP_URL`, `ROLLUP_URL` | Set only to name something else                                                                                |
| `CRANK_EVERY`, `CRANK_GIVE_UP`, `CRANK_DEADLINE` | 1, 6, 60                        | Crank: seconds between rounds, failed rounds in a row before it exits, seconds a round may take                      |
| `RELEASE_EVERY_MS`, `RELEASE_RANGE` | 600000, 2048                         | Keeper: milliseconds between release sweeps, and seats per `release_empty_seats` call. The sweep bound itself is read from the exchange |
| `KEEPER_EVERY`, `KEEPER_GIVE_UP`, `KEEPER_STALE_GIVE_UP`, `KEEPER_DEADLINE` | 1, 6, 1800, 180 | Keeper: seconds between sweeps, failed sweeps before it exits, seconds a market may read stale, seconds a sweep may take |
| `HEALTHCHECK_URL`                | unset                                   | A dead-man's switch: a plain GET after each good round or sweep, none while an `ALERT` stands (healthy, not only alive). Treat the address as a secret |
| `KEEPER_HEARTBEAT_FILE`          | unset                                   | Keeper: an absolute path. After each sweep that sends the ping above it writes the time in Unix milliseconds there (atomically, mode 0644), for a service on the same host to gate its readiness on. A failed write is logged once and never stops a sweep |

The image runs as `node` (uid 1000); any user works if it can read the mounted files and, for the keeper, write `/keys`. Run it with `--init`: without an init process the container ignores `docker stop` for ten seconds. A process that gives up exits non-zero, so the host's restart policy (and an alert on restarts) is what keeps it running. The entrypoint exits 64 for a wrong command and 78 for anything missing, each with a message that says what to mount or set, and starts nothing.

## What is not part of this launch

- **SOL/USDC spot.** The launch profile creates SOL-PERP only, and no other asset until it has run. Spot has no market on this exchange, no maker quoting it, no access lists for it and no caps sized for it; nothing in this page covers it. Its own launch is a separate decision after this one has run.
- **A hedge venue.** The maker stays close to flat by skewing its quotes, its position limit, short quote expiries and its loss limits. There is none at launch.
- **A way out for users that this repository runs for them.** `make mainnet-exit` and the round trip use the owner's own key, so they work for the house maker's seat and any seat whose key this machine holds. No tool of an operator can exit a retail user's seat, and none of the exchange's keys can. The market is kept small for that reason.
- **Sealed custody**, a second market, and the mainnet smoke (`MAINNET_SMOKE=yes`), which trades on the public tape.
- **The program's final lock.** The upgrade authority is a multisig, not none, until the program has run.
