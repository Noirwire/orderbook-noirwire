import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ORDER_KEYS,
  ORDER_TYPE,
  RESULT_KIND,
  RESULT_STATUS,
  SIDE,
} from "../../sdk/dist/index.js";
import {
  PROGRAM_ID,
  anonymous,
  instructions,
  nowSeconds,
  rollup,
  send,
  sentRaw,
  shownBy,
  until,
} from "../support";
import {
  MARK,
  SPOT,
  TINY,
  attempted,
  call,
  cast,
  custodyMatchesLedger,
  landed,
  order,
  placing,
  refuses,
  resultFor,
  soon,
} from "./world";

describe("orders, signed by one-time keys", () => {
  const ioc = (price = 140_000n, size = 10n) =>
    order(SIDE.bid, ORDER_TYPE.immediateOrCancel, price, size);

  it("is placed only by one of the view's keys, and a used key is refused afterwards", async () => {
    const { alice } = cast;
    const impostor = Keypair.generate();
    const probe = alice.keys.take();
    const wrong = instructions.placeOrder(
      { ...call(alice, probe, SPOT, 1n, soon()), orderKey: impostor.publicKey },
      ioc(),
    );
    await refuses(send(rollup, wrong, impostor), "NotOrderKey");
    alice.keys.release(probe);
    const { use } = await attempted(alice, placing(alice, SPOT, ioc()));
    const again = instructions.placeOrder(
      {
        ...call(alice, use, SPOT, 2n, soon()),
        replacement: Keypair.generate().publicKey,
      },
      ioc(),
    );
    await refuses(send(rollup, again, use.keypair), "NotOrderKey");
    const view = await alice.client.view();
    expect(view.orderKeys[use.slot].equals(use.replacement.publicKey)).to.equal(
      true,
    );
  });

  it("refuses a replacement that is a live key, the owner, or the zero key, and leaves the key live", async () => {
    const { alice } = cast;
    const live = (await alice.client.view()).orderKeys;
    const use = alice.keys.take();
    for (const replacement of [
      live[(use.slot + 1) % ORDER_KEYS],
      alice.owner.publicKey,
      PublicKey.default,
    ]) {
      const bad = instructions.placeOrder(
        { ...call(alice, use, SPOT, 3n, soon()), replacement },
        ioc(),
      );
      await refuses(send(rollup, bad, use.keypair), "InvalidOrderKey");
    }
    alice.keys.release(use);
    expect(
      (await alice.client.view()).orderKeys.map((key) => key.toBase58()),
    ).to.deep.equal(live.map((key) => key.toBase58()));
  });

  it("refuses an expired order and one that expires too far ahead, and the same key then places a fresh one", async () => {
    const { alice } = cast;
    const use = alice.keys.take();
    const expiring = (clientOrderId: bigint, secondsAhead: number) =>
      instructions.placeOrder(
        call(
          alice,
          use,
          SPOT,
          clientOrderId,
          BigInt(nowSeconds() + secondsAhead),
        ),
        ioc(),
      );
    await refuses(send(rollup, expiring(4n, -5), use.keypair), "Expired");
    await refuses(send(rollup, expiring(5n, 120), use.keypair), "ExpiryTooFar");
    await send(rollup, expiring(6n, 5), use.keypair);
    alice.keys.confirm(use);
    const result = await resultFor(alice, 6n);
    expect(result.status).to.equal(RESULT_STATUS.remainderCancelled);
  });

  it("executes the same signed order once when it is sent twice", async () => {
    const { alice } = cast;
    const use = alice.keys.take();
    const clientOrderId = 7n;
    const written = (await alice.client.view()).resultsWritten;
    const instruction = instructions.placeOrder(
      call(alice, use, SPOT, clientOrderId, soon()),
      ioc(),
    );
    const raw = await sentRaw([instruction], use.keypair);
    const sentAgain = () =>
      rollup
        .sendRawTransaction(raw, { skipPreflight: true })
        .catch(() => undefined);
    await sentAgain();
    await resultFor(alice, clientOrderId);
    await sentAgain();
    alice.keys.confirm(use);
    await until(
      async () => (await alice.client.view()).resultsWritten > written,
      "the result to be written",
    );
    const view = await alice.client.view();
    expect(view.resultsWritten).to.equal(written + 1);
    expect(
      view.results.filter((result) => result.clientOrderId === clientOrderId),
    ).to.have.length(1);
    expect(view.orderKeys[use.slot].equals(use.replacement.publicKey)).to.equal(
      true,
    );
  });

  it("signs two consecutive orders with different keys, neither the owner, and shows a stranger an empty transaction", async () => {
    const { alice } = cast;
    const first = await attempted(alice, placing(alice, SPOT, ioc()));
    const second = await attempted(alice, placing(alice, SPOT, ioc()));
    expect(
      first.use.keypair.publicKey.equals(second.use.keypair.publicKey),
    ).to.equal(false);
    for (const { use } of [first, second]) {
      expect(use.keypair.publicKey.equals(alice.owner.publicKey)).to.equal(
        false,
      );
    }
    const [latest] = await rollup.getSignaturesForAddress(PROGRAM_ID, {
      limit: 2,
    });
    const throughThePort = await shownBy(rollup, latest.signature);
    expect(
      throughThePort.accounts.get(0)?.equals(second.use.keypair.publicKey),
    ).to.equal(true);
    const shell = await shownBy(anonymous, latest.signature);
    expect(shell.accounts.length).to.equal(0);
    expect(shell.logs).to.have.length(0);
  });

  it("writes a post-only order that would match as an outcome, and leaves the book as it was", async () => {
    const { alice, bob } = cast;
    const resting = await bob.client.placeOrder(
      SPOT,
      order(SIDE.ask, ORDER_TYPE.limit, MARK, 100n),
    );
    expect(resting.outcome).to.equal("placed");
    const refused = landed(
      await alice.client.placeOrder(
        SPOT,
        order(SIDE.bid, ORDER_TYPE.postOnly, MARK, 10n),
      ),
    );
    expect(refused.status).to.equal(RESULT_STATUS.refusedPostOnlyWouldMatch);
    expect(refused.filled).to.equal(0n);
    const synced = await bob.client.syncView(SPOT);
    expect(synced.kind).to.equal(RESULT_KIND.sync);
    expect(
      (await bob.client.view()).snapshot.orders.map((entry) => entry.remaining),
    ).to.deep.equal([100n]);
    const cancelled = await bob.client.cancelAll(SPOT);
    expect(cancelled.cancelled).to.equal(1n);
  });

  it("writes a full side as an outcome: the remainder is cancelled and nothing is evicted", async () => {
    const { alice } = cast;
    const bid = async (price: bigint) =>
      landed(
        await alice.client.placeOrder(
          TINY,
          order(SIDE.bid, ORDER_TYPE.limit, price, 10n),
        ),
      );
    for (const price of [MARK - 100n, MARK - 200n]) {
      expect((await bid(price)).status).to.equal(RESULT_STATUS.rested);
    }
    const third = await bid(MARK - 300n);
    expect(third.status).to.equal(RESULT_STATUS.remainderCancelledBookFull);
    expect(third.rested).to.equal(0n);
    expect(third.cancelled).to.equal(10n);
    expect(
      (await alice.client.view()).snapshot.orders.map((entry) => entry.price),
    ).to.deep.equal([MARK - 100n, MARK - 200n]);
    expect((await alice.client.cancelAll(TINY)).cancelled).to.equal(2n);
  });

  it("writes an immediate-or-cancel that matched nothing as an outcome with nothing filled", async () => {
    const unmatched = landed(
      await cast.alice.client.placeOrder(SPOT, ioc(140_000n, 10n)),
    );
    expect(unmatched.status).to.equal(RESULT_STATUS.remainderCancelled);
    expect(unmatched.filled).to.equal(0n);
    expect(unmatched.cancelled).to.equal(10n);
  });

  it("refuses what depends only on public settings as an error that changes nothing", async () => {
    const { alice } = cast;
    for (const [price, size, error] of [
      [MARK + 1n, 1n, "PriceOffTick"],
      [MARK / 2n - 100n, 100n, "PriceOutsideBand"],
      [MARK, 100_000n, "InsufficientBalance"],
    ] as const) {
      await refuses(
        attempted(
          alice,
          placing(alice, SPOT, order(SIDE.bid, ORDER_TYPE.limit, price, size)),
        ),
        error,
      );
    }
    await custodyMatchesLedger();
  });
});
