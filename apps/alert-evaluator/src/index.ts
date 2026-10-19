import { createDatabase } from "@drone-fleet/database";
import { loadAlertPolicy } from "./config.js";
import { createAlertRepository } from "./repository.js";
import { createAlertWorker } from "./worker.js";
const policy = loadAlertPolicy();
const database = createDatabase();
const worker = createAlertWorker(
  createAlertRepository(database.db, policy),
  policy.intervalMs,
  (metrics) =>
    console.log(JSON.stringify({ event: "alert.evaluation", ...metrics })),
);
worker.start();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await worker.stop();
    await database.client.end();
  } catch {
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
