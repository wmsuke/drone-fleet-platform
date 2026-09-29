import { createDatabase } from "@drone-fleet/database";

import { buildApi } from "./app.js";
import { loadApiConfig } from "./config.js";
import { createDeviceListRepository } from "./repository.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const { client, db } = createDatabase();
  const app = buildApi(createDeviceListRepository(db));

  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await app.close();
    await client.end();
  };
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
