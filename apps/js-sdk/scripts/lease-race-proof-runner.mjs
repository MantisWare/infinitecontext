import { countDoubleHoldRuns } from "../tests/storage/lease-lock-race-harness.mjs";

const runs = Number(process.env.IC_LEASE_RACE_RUNS ?? "20");
const doubleHolds = await countDoubleHoldRuns(runs);
console.log(`IC_LEASE_RACE_DOUBLE_HOLDS=${doubleHolds}`);
if (Number.isNaN(doubleHolds)) {
  process.exit(1);
}
