/**
 * Writes the price accounts of `price-fixtures.ts` into a directory, one file
 * per account named by its address, stamped ten minutes before now:
 *
 *   ts-node tests/upgrade/write-price-fixtures.ts <directory>
 *
 * `make test-upgrade` runs it before the network starts and loads every file
 * it wrote with `--account`.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { accountFile, priceFixtures } from "./price-fixtures";

const STAMPED_BEFORE_NOW_SECONDS = 600;

const directory = process.argv[2];
if (!directory) throw new Error("Name the directory to write the accounts to");
mkdirSync(directory, { recursive: true });
const publishedAt = Math.floor(Date.now() / 1000) - STAMPED_BEFORE_NOW_SECONDS;
for (const fixture of Object.values(priceFixtures(publishedAt))) {
  writeFileSync(
    join(directory, `${fixture.address.toBase58()}.json`),
    JSON.stringify(accountFile(fixture)),
  );
}
