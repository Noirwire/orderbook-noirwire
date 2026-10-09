# Spike findings

Seven questions about a private order book on MagicBlock's Private Ephemeral Rollup,
answered by running code. The code is in `spike/` (`make install build up`, then
`make q1` to `make q7`, then `make down`; `make q8` is a read-only look at devnet).

Everything was run on **one laptop**: Apple M4, 10 cores, 32 GB. The client, the Solana
validator, the rollup and the query filter all ran on that machine over loopback. No
number here is a network number. Local rollup version 0.14.10; devnet runs 1.0.0, so
each result needs repeating there before it is relied on.

A **sealed** account is private with an empty member list. The **filter** is the query
filter (port 6699); the **rollup port** is the validator's own (7799).

| # | Question | Result |
| --- | --- | --- |
| 1 | Sealed account | Proven. The program reads and writes it for any signer. The filter returns nothing for it to anyone, the writer included. The rollup port returns everything to anyone: the filter is the only guard. |
| 2 | Transaction visibility | Proven, with leaks. Through the filter a transaction that touches a sealed account shows no keys, data, logs or balances to anyone, the sender included. Still public: that the signature exists, its time, its error, and its place in the signature list of the program id and of the signer's key. Simulating a transaction through the filter returns its error. |
| 3 | Large accounts | Proven inside the rollup, failed by delegation. 1 MB created in the rollup: 0.27 s, 5 transactions, 0.034 SOL from the sponsor. Growth is 10,240 bytes per instruction, 30 per transaction. Delegating a Solana account above 10,240 bytes fails. A match costs about 160 compute units per fill: 1,746 for 1 fill, 3,203 for 10, 6,745 for 32. The ceiling is 1.4 million. |
| 4 | Tokens | Proven locally. A balance moved into the rollup, a deposit to a program-owned token account, a program-signed payout, private balances and private custody all worked. In the rollup a balance is an ordinary SPL token account. Withdrawal to Solana was not tested. |
| 5 | Websockets | Proven. Account subscriptions work through the filter, publicly for public accounts and for members on private ones. A notification arrives within a millisecond of the write. |
| 6 | Speed | Proven, one open problem. One transaction is final about 0.25 ms after it is sent (median; p99 0.5 ms). One sender sustained 2,400 writes a second on one account for 30 s; a 10-fill match sustained about 2,000 transactions a second. With 16 and 64 senders, 5% to 17% of accepted transactions never executed and returned no error. Cause not found. A key with no lamports can pay: the fee is zero. |
| 7 | Scheduler | Proven. A scheduled instruction ran every iteration at 1000, 100 and 10 ms, at no cost. Runs are signed by the validator. Anyone can schedule; only the scheduler's payer can cancel. |
| 8 | Devnet (read-only) | The private validator answers over websockets and has the token and permission programs. |

## What the design took from this

1. Book and ledger are created inside the rollup and grown in steps.
2. A trader's only feedback is state, so every instruction writes its outcome to the
   trader's own view.
3. A refusal that depends on the book is an outcome, not an error.
4. Signature lists leak who transacted and when, so trading is signed by one-time keys.
5. Token accounts are public unless each has a permission, so custody is private.
6. An accepted send is not an executed order. Clients confirm from state and resend.
7. Fees are zero, so every limit on spam has to be in the program.
8. Compute is not a constraint. Storage for large accounts may be.

## Not tested

Withdrawal to Solana; anything on devnet beyond reads; why transactions go unexecuted
under concurrent load; what happens to rollup-only accounts if the rollup's storage is
lost; scheduler intervals under 10 ms.
