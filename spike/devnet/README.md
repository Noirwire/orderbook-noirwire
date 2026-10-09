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

## Keys

Throwaway keys and progress are kept in `devnet/.keys/state.json`, which git
ignores. Delete that file to start again with a new mint and new holders.
No secret key is printed.
