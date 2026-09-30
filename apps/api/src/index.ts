import { createDatabase } from "@drone-fleet/database";
import { connectAsync } from "mqtt";

import { buildApi } from "./app.js";
import { createCommandPublisher } from "./command-publisher.js";
import { createCommandRepository } from "./command-repository.js";
import { createCommandService } from "./command-service.js";
import { loadApiConfig } from "./config.js";
import { createDeviceRepository } from "./repository.js";
import { createShutdown } from "./shutdown.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const { client, db } = createDatabase();
  let mqttClient;
  try {
    mqttClient = await connectAsync(config.mqttUrl, {
      clean: true,
      clientId: "fleet-api",
    });
  } catch (error) {
    await client.end();
    throw error;
  }
  const commandService = createCommandService(
    createCommandRepository(db),
    createCommandPublisher(mqttClient),
  );
  const app = buildApi(createDeviceRepository(db), commandService);

  const shutdown = createShutdown(app, mqttClient, client);
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  try {
    await app.listen(config);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error("APIの起動に失敗しました", error);
  process.exitCode = 1;
});
