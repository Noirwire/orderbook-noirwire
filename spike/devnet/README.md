# Devnet token probe

Answers one question by experiment: do token balances work through
MagicBlock's hosted private rollup endpoint (`https://devnet-tee.magicblock.app`)
on Solana devnet?

Devnet only. The script checks the genesis hash and the rollup's identity
before every stage and stops if either is wrong.

## Run

From the `spike` folder (it uses `spike/node_modules`):

```bash
P="node_modules/.bin/ts-node -P tsconfig.json devnet/token-probe.ts"
$P fund 0.2     # move devnet SOL from the funded devnet wallet to the throwaway payer (capped at 0.6 in total)
$P base         # mint, holders, balances into the rollup, two custody accounts
$P read         # who can read what through the hosted endpoint
$P transfers    # plain SPL transfers inside the rollup, simulated and sent
$P custody      # deposits to an account nobody can sign for, public and private
$P history      # getTransaction and getSignaturesForAddress as each caller
$P latency      # 20 transfers and 20 getSlot calls, timed from this machine
$P withdraw     # undelegate in the rollup, then withdraw on Solana
$P balances     # what each Solana step cost the payer
$P peek         # raw getTransaction and signature-list answers
```

Stages on Solana are remembered and skipped on a second run. `withdraw`
takes alice out of the rollup, so run it last; a fresh run needs a fresh
state file.

## This program's instructions through the hosted endpoint

Measured 2026-10-09 by simulating and sending transactions of the order book
program (magicblock-core 1.0.0). `403` is HTTP 403 `{"error":"Access denied"}`,
the same anonymously and signed in, for `simulateTransaction` and for
`sendTransaction` with preflight skipped.

| The transaction names                                                              | Answer                   |
| ---------------------------------------------------------------------------------- | ------------------------ |
| no token account (`set_paused`, ledger, markets, orders, `sync_view`)              | accepted                 |
| the custody permission account alone                                               | accepted                 |
| a private custody token account, or its ephemeral balance account                  | 403                      |
| a private custody whose permission exists on Solana and was never delegated        | 403                      |
| a private balance of the signer, who owns it and is signed in                      | 403                      |
| the same, with an SPL transfer of that balance in the same transaction             | 403                      |
| a public token account, whoever owns it (a custody nobody signs for, or a holder)  | accepted                 |
| the signer's private balance, from the Associated Token program instead of ours    | accepted                 |

So the refusal is per transaction, keyed on the program, and does not depend
on who signs, who is signed in or what the permission's members may do: the
members of a token permission are fixed (the token program, and the owner
with the authority flag only). `register_token` requires a private custody
permission, so it is refused, and so are `deposit`, `withdraw`, `collect_fees`
and `fund_insurance`. A public custody would be accepted by the endpoint and
is refused by the program (`CustodyNotPrivate`).

## Keys

Throwaway keys and progress are kept in `devnet/.keys/state.json`, which git
ignores. Delete that file to start again with a new mint and new holders.
No secret key is printed.
