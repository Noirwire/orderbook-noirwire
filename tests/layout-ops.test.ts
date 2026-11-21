import { expect } from "chai";
import {
  MAX_FIRES_PER_PASS,
  MAX_SEATS,
  PERP_TRIGGER_BOOK_LEN,
  SWEEP_TRIGGER_SLOTS_PER_CALL,
  TRIGGER_BOOK_VERSION,
} from "../sdk/dist/index.js";
import {
  activationRefusal,
  deployReadiness,
  halvedScanCount,
  layoutRefusal,
  layoutRequest,
  layoutStatus,
  nextScanCount,
  scanLedger,
  type LayoutExchange,
} from "../ops/layouting";
import {
  readyBookVerdict,
  triggerBookStateOf,
  triggerBookStatus,
} from "../ops/triggerbooks";
import {
  MAX_PASSES_PER_ROUND,
  SWEEP_CLEAN_BEFORE_GROWING,
  afterOutcome,
  afterPass,
  afterSweepCall,
  firePasses,
  futurePrintAlert,
  initialSweepWindow,
  isComputeFailure,
  refusalOutcome,
  signedAgeSeconds,
  sweepOnce,
  sweepProgress,
  withIncident,
  type SweepWindow,
} from "../ops/upkeep";

const failed = (code: number) =>
  `{"InstructionError":[0,{"Custom":${code}}]}\nProgram log: ...`;
const FULL = SWEEP_TRIGGER_SLOTS_PER_CALL;
const computeFailure = new Error(
  '{"InstructionError":[1,"ComputationalBudgetExceeded"]}',
);

describe("the crank's trigger passes", () => {
  it("is done after a pass that left a slot unused, whatever the counter says of other traders before it", () => {
    expect(afterPass(100n, 100n, 1, MAX_FIRES_PER_PASS)).to.equal("done");
    expect(afterPass(100n, 103n, 1, MAX_FIRES_PER_PASS)).to.equal("done");
    expect(
      afterPass(100n, 99n, 1, MAX_FIRES_PER_PASS),
      "a counter that went back",
    ).to.equal("done");
  });

  it("sends another after a pass that used every slot, until the round's passes are spent", () => {
    for (let passes = 1; passes < MAX_PASSES_PER_ROUND; passes += 1) {
      expect(afterPass(0n, 4n, passes, MAX_FIRES_PER_PASS)).to.equal("again");
    }
    expect(
      afterPass(0n, 4n, MAX_PASSES_PER_ROUND, MAX_FIRES_PER_PASS),
    ).to.equal("saturated");
  });

  it("sends a second pass when the first used every slot, and a third only when the second did", async () => {
    let orders = 0n;
    let sent = 0;
    const used = [4n, 1n];
    const passes = await firePasses(
      async () => {
        orders += used[sent] ?? 0n;
        sent += 1;
      },
      async () => orders,
      MAX_FIRES_PER_PASS,
      () => expect.fail("the round was not saturated"),
    );
    expect(passes).to.equal(2);
    expect(sent).to.equal(2);
  });

  it("sends one pass when the first left a slot unused, and no alert", async () => {
    let orders = 0n;
    let sent = 0;
    const passes = await firePasses(
      async () => {
        orders += 3n;
        sent += 1;
      },
      async () => orders,
      MAX_FIRES_PER_PASS,
      () => expect.fail("the round was not saturated"),
    );
    expect([passes, sent]).to.deep.equal([1, 1]);
  });

  it("stops at the round's limit when every pass is full, and says so once", async () => {
    let orders = 0n;
    let sent = 0;
    const alerts: number[] = [];
    const passes = await firePasses(
      async () => {
        orders += 4n;
        sent += 1;
      },
      async () => orders,
      MAX_FIRES_PER_PASS,
      (count) => alerts.push(count),
    );
    expect(passes).to.equal(MAX_PASSES_PER_ROUND);
    expect(sent).to.equal(MAX_PASSES_PER_ROUND);
    expect(alerts).to.deep.equal([MAX_PASSES_PER_ROUND]);
  });

  it("lets a failing pass end the round without sending it again", async () => {
    let sent = 0;
    let orders = 0n;
    const outcome = await firePasses(
      async () => {
        sent += 1;
        if (sent === 2) throw new Error("the send failed");
        orders += 4n;
      },
      async () => orders,
      MAX_FIRES_PER_PASS,
      () => {},
    ).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(outcome).to.equal("the send failed");
    expect(sent).to.equal(2);
  });
});

describe("the crank's oracle age", () => {
  it("keeps the sign of the age, so a print from the future reads negative", () => {
    expect(signedAgeSeconds(1_000, 990)).to.equal(10);
    expect(signedAgeSeconds(1_000, 1_003)).to.equal(-3);
  });

  it("calls the program's refusal of a print from the future a retry, not a failure", () => {
    expect(refusalOutcome(failed(6074))).to.equal("future");
    let streaks = new Map<string, number>([["market 1", 2]]);
    streaks = afterOutcome(streaks, "market 1", "future");
    expect(streaks.get("market 1"), "not counted toward giving up").to.equal(0);
    expect(withIncident("future", "dislocated")).to.equal("future");
    expect(refusalOutcome(failed(6081))).to.equal("refused");
  });

  it("raises an alert line for a negative age only, naming the signed age", () => {
    expect(futurePrintAlert("market 1", 4)).to.equal(null);
    expect(futurePrintAlert("market 1", 0)).to.equal(null);
    expect(futurePrintAlert("market 1", null)).to.equal(null);
    const alert = futurePrintAlert("market 1", -3)!;
    expect(alert).to.match(/^ALERT market 1: /);
    expect(alert).to.include("3 s ahead");
    expect(alert).to.include("clock - publish -3 s");
  });
});

describe("the keeper's trigger sweep", () => {
  it("tells a call that ran out of compute from any other failure", () => {
    expect(isComputeFailure(computeFailure.message)).to.equal(true);
    expect(
      isComputeFailure("Program failed: exceeded CUs meter at BPF"),
    ).to.equal(true);
    expect(
      isComputeFailure("exceeded maximum number of instructions allowed"),
    ).to.equal(true);
    expect(isComputeFailure(failed(6174))).to.equal(false);
    expect(isComputeFailure("fetch failed")).to.equal(false);
  });

  it("halves the window after each compute failure, down to one slot, and never sends the failed window twice in a row", () => {
    let window = initialSweepWindow(FULL);
    const seen = [window.slots];
    for (let step = 0; step < 13; step += 1) {
      window = afterSweepCall(window, "compute", FULL);
      seen.push(window.slots);
    }
    expect(seen.slice(0, 4)).to.deep.equal([2048, 1024, 512, 256]);
    expect(seen.at(-1)).to.equal(1);
    const firstOne = seen.indexOf(1);
    for (let at = 1; at <= firstOne; at += 1) {
      expect(seen[at], "each failure asks for fewer").to.be.lessThan(
        seen[at - 1],
      );
    }
  });

  it("leaves the window alone after another failure and wins it back by doubling after a run of good calls", () => {
    let window: SweepWindow = { slots: 256, clean: 3 };
    window = afterSweepCall(window, "failed", FULL);
    expect(window).to.deep.equal({ slots: 256, clean: 0 });
    for (let call = 1; call < SWEEP_CLEAN_BEFORE_GROWING; call += 1) {
      window = afterSweepCall(window, "ok", FULL);
      expect(window.slots).to.equal(256);
    }
    window = afterSweepCall(window, "ok", FULL);
    expect(window).to.deep.equal({ slots: 512, clean: 0 });
    const full = afterSweepCall({ slots: FULL, clean: 20 }, "ok", FULL);
    expect(full.slots, "never past the most a call may read").to.equal(FULL);
  });

  it("sends exactly one call per market per pass and asks half the next time after a compute failure", async () => {
    const asked: number[] = [];
    const lines: string[] = [];
    let window = initialSweepWindow(FULL);
    const failures: boolean[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const swept = await sweepOnce({
        marketId: 1,
        window,
        full: FULL,
        capacity: 8_192,
        send: async (slots) => {
          asked.push(slots);
          if (slots > 512) throw computeFailure;
        },
        cursor: async () => null,
        say: (line) => lines.push(line),
      });
      failures.push(swept.failed);
      window = swept.window;
    }
    expect(asked, "one call a pass, each smaller").to.deep.equal([
      2048, 1024, 512,
    ]);
    expect(failures).to.deep.equal([true, true, false]);
    expect(lines).to.have.length(2);
    expect(lines[0]).to.include("the next call asks for 1024 slots");
    expect(
      window.slots,
      "a good call keeps the window it went through at",
    ).to.equal(512);
  });

  it("reads where a call that stopped early left the cursor, and resumes there", async () => {
    const lines: string[] = [];
    let cursor = 0;
    const book = { stopAfter: 640 };
    const sweep = async (window: SweepWindow) =>
      sweepOnce({
        marketId: 2,
        window,
        full: FULL,
        capacity: 8_192,
        send: async (slots) => {
          cursor += Math.min(slots, book.stopAfter);
        },
        cursor: async () => cursor,
        say: (line) => lines.push(line),
      });
    const first = await sweep(initialSweepWindow(FULL));
    expect(first.failed).to.equal(false);
    expect(cursor).to.equal(640);
    expect(lines).to.have.length(1);
    expect(lines[0]).to.include("read 640 of 2048 slots");
    expect(lines[0]).to.include("stopped at 640 of 8192");
    expect(lines[0]).to.include("the next call resumes there");
    book.stopAfter = FULL;
    const second = await sweep(first.window);
    expect(second.failed).to.equal(false);
    expect(cursor, "the next call began at 640").to.equal(640 + FULL);
    expect(lines, "a whole window says nothing").to.have.length(1);
  });

  it("reads progress from the cursors: early, a whole window, a wrap at the end, and unreadable", () => {
    expect(sweepProgress(100, 740, 2_048, 8_192)).to.deep.equal({
      from: 100,
      read: 640,
      early: true,
    });
    expect(sweepProgress(100, 2_148, 2_048, 8_192)).to.deep.equal({
      from: 100,
      read: 2_048,
      early: false,
    });
    expect(sweepProgress(8_000, 8_192, 2_048, 8_192)?.early).to.equal(false);
    expect(sweepProgress(8_000, 1_000, 2_048, 8_192)).to.deep.equal({
      from: 8_000,
      read: 1_192,
      early: false,
    });
    expect(sweepProgress(null, 5, 2_048, 8_192)).to.equal(null);
    expect(sweepProgress(5, null, 2_048, 8_192)).to.equal(null);
  });

  it("does not say a failed call stopped early, and keeps a failure that is not compute at the same window", async () => {
    const lines: string[] = [];
    const swept = await sweepOnce({
      marketId: 4,
      window: { slots: 512, clean: 2 },
      full: FULL,
      capacity: 8_192,
      send: async () => {
        throw new Error("fetch failed");
      },
      cursor: async () => 0,
      say: (line) => lines.push(line),
    });
    expect(swept).to.deep.equal({
      failed: true,
      window: { slots: 512, clean: 0 },
    });
    expect(lines).to.have.length(1);
    expect(lines[0]).to.include("fetch failed");
    expect(lines[0]).to.not.include("the next call asks");
  });
});

describe("the layout command", () => {
  const base: LayoutExchange & { layout: number } = {
    layoutState: "preActivation",
    paused: true,
    seatCapacity: 2_048,
    layout: 0x3258574e,
  };

  it("reads APPLY and ACTIVATE strictly, and takes the scan size from SCAN_SEATS", () => {
    expect(layoutRequest({})).to.deep.equal({
      apply: false,
      activate: false,
      seatsPerCall: 2_048,
    });
    expect(layoutRequest({ APPLY: "yes", SCAN_SEATS: "512" })).to.deep.equal({
      apply: true,
      activate: false,
      seatsPerCall: 512,
    });
    expect(layoutRequest({ APPLY: "yes", ACTIVATE: "yes" }).activate).to.equal(
      true,
    );
    expect(() => layoutRequest({ ACTIVATE: "yes" })).to.throw("with APPLY=yes");
    expect(() => layoutRequest({ APPLY: "yes", ACTIVATE: "true" })).to.throw(
      "ACTIVATE is true",
    );
    expect(() => layoutRequest({ APPLY: "true" })).to.throw("APPLY is");
    expect(() => layoutRequest({ SCAN_SEATS: "0" })).to.throw("SCAN_SEATS");
    expect(() => layoutRequest({ SCAN_SEATS: "70000" })).to.throw("more than");
  });

  it("works on a paused exchange that has not been activated, and on an active one, and on no other", () => {
    expect(layoutRefusal(base)).to.equal(null);
    expect(layoutRefusal({ ...base, layoutState: "live" })).to.equal(null);
    expect(layoutRefusal({ ...base, paused: false })).to.match(/not paused/);
    expect(
      layoutRefusal({ ...base, layoutState: "live", paused: false }),
      "an active exchange has nothing to do, paused or not",
    ).to.equal(null);
    expect(layoutRefusal({ ...base, layoutState: "unmigrated" })).to.match(
      /does not have a layout/,
    );
  });

  it("refuses to activate unless the exchange is paused and the scan has read exactly the ledger's seats", () => {
    expect(
      activationRefusal(base, { cursor: 2_048, capacity: 2_048 }),
    ).to.equal(null);
    expect(
      activationRefusal(
        { ...base, paused: false },
        { cursor: 2_048, capacity: 2_048 },
      ),
    ).to.match(/not paused/);
    expect(activationRefusal(base, null)).to.match(
      /not started: it has read 0 of 2048/,
    );
    expect(
      activationRefusal(base, { cursor: 2_047, capacity: 2_048 }),
    ).to.match(/read 2047 of 2048 seats/);
    expect(
      activationRefusal(base, { cursor: 2_048, capacity: 2_048 }),
      "a scan begun at a smaller ledger is fine once it has caught up",
    ).to.equal(null);
    expect(
      activationRefusal(base, { cursor: 2_100, capacity: 2_048 }),
    ).to.match(/read 2100 of 2048 seats/);
    expect(
      activationRefusal(
        { ...base, seatCapacity: null },
        { cursor: 0, capacity: 0 },
      ),
    ).to.match(/no seat capacity/);
  });

  it("asks for what is left of the ledger in the last call, and halves after compute", () => {
    expect(nextScanCount(0, 5_000, 2_048)).to.equal(2_048);
    expect(nextScanCount(4_096, 5_000, 2_048)).to.equal(904);
    expect(nextScanCount(5_000, 5_000, 2_048)).to.equal(0);
    expect(halvedScanCount(2_048)).to.equal(1_024);
    expect(halvedScanCount(1)).to.equal(1);
  });

  it("scans to the end in calls of the requested size, and halves the size after a call that ran out of compute", async () => {
    const asked: number[] = [];
    const said: string[] = [];
    let cursor = 0;
    const ended = await scanLedger({
      cursor: 0,
      capacity: 5_000,
      perCall: 2_048,
      send: async (count) => {
        asked.push(count);
        if (count > 1_000) throw computeFailure;
        cursor += count;
      },
      read: async (after) => {
        expect(cursor).to.be.greaterThan(after);
        return cursor;
      },
      say: (line) => said.push(line),
    });
    expect(ended).to.equal(5_000);
    expect(asked.slice(0, 2)).to.deep.equal([2_048, 1_024]);
    expect(asked.filter((count) => count === 2_048)).to.have.length(1);
    expect(asked.filter((count) => count === 1_024)).to.have.length(1);
    expect(said).to.have.length(2);
    expect(said[0]).to.include("changed nothing");
  });

  it("resumes at the cursor it is given, and stops on a refusal that is not about compute, with the scan where it stood", async () => {
    const asked: number[] = [];
    let cursor = 1_000;
    const outcome = await scanLedger({
      cursor,
      capacity: 5_000,
      perCall: 2_048,
      send: async (count) => {
        asked.push(count);
        if (asked.length === 2) throw new Error(failed(6177));
        cursor += count;
      },
      read: async () => cursor,
      say: () => {},
    }).then(
      () => "scanned",
      (error: Error) => error.message,
    );
    expect(asked).to.deep.equal([2_048, 1_952]);
    expect(outcome).to.include("6177");
    expect(cursor).to.equal(3_048);
  });

  it("reports the layout, the scan and the capacity for the status command", () => {
    expect(layoutStatus(base, null)).to.deep.equal({
      layout: "NWX2, NOT ACTIVE: the earlier build's seats",
      scan: "not started (0 of 2048 seats)",
    });
    expect(
      layoutStatus(base, { cursor: 1_024, capacity: 2_048 }).scan,
    ).to.equal("1024 of 2048 seats read (the ledger held 2048 when it began)");
    expect(
      layoutStatus(base, { cursor: 2_048, capacity: 2_048 }).scan,
    ).to.include("complete");
    const live = layoutStatus(
      { ...base, layoutState: "live", layout: 0x3358574e },
      { cursor: 2_048, capacity: 2_048 },
    );
    expect(live.layout).to.equal("NWX3, active");
    expect(
      layoutStatus({ ...base, layoutState: "live", layout: 0x3358574e }, null)
        .scan,
    ).to.equal("none (not needed)");
    expect(
      layoutStatus({ ...base, layoutState: "unmigrated", layout: 0 }, null)
        .layout,
    ).to.include("NOT A LAYOUT");
  });

  it("reports ready to deploy only on NWX2 or NWX3, and says which, and stops on any other layout", () => {
    const before = deployReadiness(base);
    expect(before.ready).to.equal(true);
    expect(before.text).to.equal(
      "ready to deploy: the layout is NWX2, the layout before the upgrade",
    );
    const after = deployReadiness({
      ...base,
      layoutState: "live",
      layout: 0x3358574e,
    });
    expect(after.ready).to.equal(true);
    expect(after.text).to.include("NWX3");
    expect(after.text).to.not.include("ready to deploy");
    for (const layout of [0, 0x5258574e]) {
      const unknown = deployReadiness({
        ...base,
        layoutState: "unmigrated",
        layout,
      });
      expect(unknown.ready, `${layout}`).to.equal(false);
      expect(unknown.text).to.include("STOP");
      expect(unknown.text).to.include("neither NWX2");
    }
  });
});

describe("the trigger book checks of the operator commands", () => {
  const current = {
    version: TRIGGER_BOOK_VERSION,
    seatCapacity: MAX_SEATS,
    length: PERP_TRIGGER_BOOK_LEN,
    sweepCursor: 77,
  };

  it("prints a book's version, capacity, length and sweep cursor, and says when it is current", () => {
    expect(triggerBookStatus(current)).to.equal(
      `version 2, capacity ${MAX_SEATS} seats, ${PERP_TRIGGER_BOOK_LEN} bytes, sweep cursor 77, current`,
    );
  });

  it("says plainly when a book is not the current version, capacity or length", () => {
    for (const wrong of [
      { ...current, version: 1 },
      { ...current, seatCapacity: 2_048 },
      { ...current, length: PERP_TRIGGER_BOOK_LEN - 8 },
    ]) {
      expect(triggerBookStatus(wrong)).to.include("NOT CURRENT");
    }
  });

  it("says a sealed book cannot be read from here, instead of printing a guess", () => {
    expect(triggerBookStatus(null)).to.match(/sealed and not readable/);
  });

  it("reads a ready book as current or refused from what a sweep on it would fail with", () => {
    expect(readyBookVerdict(null, 1)).to.equal("current");
    expect(readyBookVerdict(failed(6163), 1)).to.equal("refused");
    expect(readyBookVerdict(failed(6174), 1)).to.equal("refused");
    expect(() => readyBookVerdict(failed(6175), 1)).to.throw(
      "does not know how to read",
    );
    expect(() => readyBookVerdict('"AccountNotFound"', 2)).to.throw("market 2");
  });

  it("still reads the program's refusals of finalize_trigger_book into the same four states", () => {
    expect(triggerBookStateOf(null, 1)).to.equal("grown");
    expect(triggerBookStateOf(failed(6120), 1)).to.equal("ready");
    expect(triggerBookStateOf(failed(6118), 1)).to.equal("partial");
    expect(triggerBookStateOf(failed(6114), 1)).to.equal("missing");
  });
});
