import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import { MAX_FILLS, TOKENS } from "../../sdk/dist/index.js";
import { ensureExchange } from "../../ops/exchange";
import { airdropped } from "../../ops/sending";
import {
  VALIDATOR,
  addresses,
  admin,
  instructions,
  rollup,
  send,
  solana,
} from "../support";
import { handsOverItsAdminRole } from "./admin-hand-over";
import {
  EXCHANGE_FLOAT,
  exchangeBalance,
  exchangeOn,
  gate,
  oracle,
  refuses,
  settings,
  stranger,
} from "./world";

describe("the exchange, on Solana", () => {
  before(async () => {
    await Promise.all([
      airdropped(solana, admin.publicKey, 100),
      airdropped(solana, stranger.publicKey, 5),
    ]);
  });

  it("can only be set up by the program's upgrade authority", async () => {
    await refuses(
      send(
        solana,
        instructions.initializeExchange(stranger.publicKey, settings()),
        stranger,
      ),
      "NotUpgradeAuthority",
    );
    expect(await solana.getAccountInfo(addresses.exchange)).to.equal(null);
  });

  it("refuses a step limit of zero or above what one order may perform, and an unknown collateral token", async () => {
    for (const over of [
      { maxSteps: 0 },
      { maxSteps: MAX_FILLS + 1 },
      { collateralToken: TOKENS },
    ]) {
      await refuses(
        send(
          solana,
          instructions.initializeExchange(admin.publicKey, settings(over)),
          admin,
        ),
        "InvalidSettings",
      );
    }
  });

  it("is set up by the upgrade authority, who becomes its admin, and takes a plain transfer from anyone", async () => {
    await send(
      solana,
      instructions.initializeExchange(admin.publicKey, settings()),
      admin,
    );
    const exchange = await exchangeOn(solana);
    expect(exchange.admin.equals(admin.publicKey)).to.equal(true);
    expect(exchange.gate.equals(gate.publicKey)).to.equal(true);
    await send(
      solana,
      SystemProgram.transfer({
        fromPubkey: stranger.publicKey,
        toPubkey: addresses.exchange,
        lamports: EXCHANGE_FLOAT,
      }),
      stranger,
    );
    const account = await solana.getAccountInfo(addresses.exchange);
    const rent = await solana.getMinimumBalanceForRentExemption(
      account?.data.length ?? 0,
    );
    expect(account).to.not.equal(null);
    expect(await solana.getBalance(addresses.exchange)).to.equal(
      rent + EXCHANGE_FLOAT,
    );
  });

  handsOverItsAdminRole(solana, (by) => [
    instructions.updateExchange(by, settings()),
    instructions.setPaused(by, true),
    instructions.proposeAdmin(by, by),
    instructions.withdrawExchange(by, 1n),
    instructions.delegateExchange(by, VALIDATOR),
  ]);

  it("is delegated to the rollup only by its admin, with its whole balance", async () => {
    await refuses(
      send(
        solana,
        instructions.delegateExchange(stranger.publicKey, VALIDATOR),
        stranger,
      ),
      "NotAdmin",
    );
    const balance = await solana.getBalance(addresses.exchange);
    await ensureExchange({
      solana,
      rollup,
      admin,
      gate: gate.publicKey,
      oracle: oracle.publicKey,
      validator: VALIDATOR,
      floatLamports: EXCHANGE_FLOAT,
    });
    expect(await exchangeBalance()).to.equal(balance);
  });
});
