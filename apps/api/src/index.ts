import { createDatabase } from "@drone-fleet/database";

import { buildApi } from "./app.js";
import {
  createFleetOperationRepository,
  loadFleetOperationOptions,
} from "./fleet-operation-repository.js";
import { createGroupRepository } from "./group-repository.js";
import { createAlertRepository } from "./alert-repository.js";
import { createAuditQueryRepository } from "./audit-query-repository.js";
import { createCommandOutbox, loadOutboxOptions } from "./command-outbox.js";
import { createOutboxPublisher } from "./outbox-publisher.js";
import { createCommandRepository } from "./command-repository.js";
import { createCommandService } from "./command-service.js";
import { loadApiConfig } from "./config.js";
import { createApiMqttConnectionConfig } from "./mqtt-transport.js";
import { createDeviceRepository } from "./repository.js";
import { createShutdown } from "./shutdown.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const outboxOptions = loadOutboxOptions();
  const fleetOptions = loadFleetOperationOptions();
  const { client, db } = createDatabase();
  let connection;
  try {
    connection = await createApiMqttConnectionConfig(config.mqttTransport);
  } catch (error) {
    await client.end();
    throw error;
  }
  const commandService = createCommandService(createCommandRepository(db));
  const outbox = createCommandOutbox(
    client,
    createOutboxPublisher(connection),
    outboxOptions,
  );
  const app = buildApi(createDeviceRepository(db), commandService, {
    auditDatabase: db,
    auditQueryRepository: createAuditQueryRepository(db),
    dashboardOrigin: config.dashboardOrigin,
    outboxStatus: outbox.status,
    groupRepository: createGroupRepository(db),
    alertRepository: createAlertRepository(db),
    fleetOperationRepository: createFleetOperationRepository(db, {
      ...fleetOptions,
      onAccepted: (metrics) =>
        console.info(
          JSON.stringify({ event: "fleet.operation.accepted", ...metrics }),
        ),
    }),
  });

  outbox.start();
  const shutdown = createShutdown(app, null, client, outbox);
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
