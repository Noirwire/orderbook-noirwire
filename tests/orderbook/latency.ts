import { expect } from "chai";
import { ORDER_TYPE, RESULTS, SIDE } from "../../sdk/dist/index.js";
import { spread } from "../../ops/stats";
import { MARK, SPOT, cast, order } from "./world";

const ORDERS = 300;

describe("latency, measured", () => {
  it(`prints the time from send to the result in the view over ${ORDERS} orders`, async () => {
    const { alice } = cast;
    const samples: number[] = [];
    for (let nth = 0; nth < ORDERS; nth += 1) {
      const started = performance.now();
      const placed = await alice.client.placeOrder(
        SPOT,
        order(SIDE.bid, ORDER_TYPE.immediateOrCancel, MARK - 5_000n, 10n),
        { pollMs: 1 },
      );
      if (placed.outcome !== "placed") throw new Error(`order ${nth} expired`);
      samples.push(performance.now() - started);
    }
    console.log(
      `      from send to the result in the view, ${ORDERS} orders: ${spread(samples)}`,
    );
    expect(samples).to.have.length(ORDERS);
    const view = await alice.client.view();
    expect(view.results.length).to.equal(RESULTS);
  });
});
