import { createDatabase } from "@drone-fleet/database";

import { createCommandAcknowledgementRepository } from "./acknowledgement.js";
import { startTelemetryIngestor } from "./app.js";
import { loadTelemetryIngestorConfig } from "./config.js";
import { createTelemetryRepository } from "./repository.js";
import { createDeviceStatusRepository } from "./status.js";

async function main(): Promise<void> {
  const config = loadTelemetryIngestorConfig();
  const { client: databaseClient, db } = createDatabase();
  const repository = createTelemetryRepository(db);
  const statusRepository = createDeviceStatusRepository(db);
  const acknowledgementRepository = createCommandAcknowledgementRepository(db);

  let ingestor;
  try {
    ingestor = await startTelemetryIngestor(
      config,
      repository,
      statusRepository,
      acknowledgementRepository,
    );
  } catch (error) {
    await databaseClient.end();
    throw error;
  }

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    console.log(`${signal}を受信したためMQTT受信処理を停止します`);

    try {
      try {
        await ingestor.shutdown();
      } finally {
        await databaseClient.end();
      }
      process.exitCode = 0;
    } catch (error) {
      console.error("MQTT受信処理の停止に失敗しました", error);
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("MQTT受信処理の起動に失敗しました", error);
  process.exitCode = 1;
});
