# Contributing

## Before you commit

Run all three. CI runs the same targets and a pull request does not merge until they pass.

```sh
make check
make audit
make test
```

`make format` fixes formatting. `make test` builds the program and the client and runs the whole suite against a fresh local network, which takes a few minutes.

## Commits

- Keep the subject under 50 characters.
- Start it with a conventional prefix: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:` or `build:`.
- Write it in the imperative: `fix: refuse a stale expiry`, not `fixed` or `fixes`.
- One change per commit. Explain why in the body when the reason is not obvious from the change.

## Where things go

- `docs/` is the contract: the design, the money rules and what was measured. Change the documents first, then the code.
- `crates/engine` owns every money rule. The program never reimplements one; if the engine lacks something, add it there with its test.
- `programs/noirwire-orderbook` owns accounts, authority, permissions, custody, the per-trader view and the calls into the engine.
- `sdk/` is the client every other service uses. It has no framework code and no Node-only imports in the browser path.
- `tests/` proves the program through the client. `ops/` operates a deployment and shares its helpers with the tests.

## Tests

Every change comes with its tests. A new rule has a test for each branch; a fixed bug has a test that failed before the fix.

- Give each test one failure it uniquely catches.
- Assert money, authority or an observable decision, never prose.
- Use controlled clocks where a clock is involved, otherwise bounded polling, never bare sleeps.
- Read sealed accounts through the rollup's own port only to check invariants, never to make a decision the client could not make.

## Code

- No dead code and no commented-out code. A comment states a security reason or an invariant, never what the code already says.
- Every account a caller passes is checked for owner, derivation and writability. No `remaining_accounts` without the same checks. No `init_if_needed`.
- One error enum with stable codes. Engine errors map one to one; a new code goes at the end.
- A refusal that depends on the contents of a book is an outcome written to the view, never an error.
- Build exactly what the change needs. A new dependency needs a reason in the pull request, pinned to an exact version.
- No em dashes in anything that ships.
