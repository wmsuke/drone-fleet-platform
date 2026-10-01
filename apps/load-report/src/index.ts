import { createDatabase } from "@drone-fleet/database";

import { assertCompleteReport, createLoadTestReport } from "./aggregate.js";
import { loadLoadReportConfig } from "./config.js";
import {
  readGeneratorReport,
  readIngestorReport,
  writeLoadTestReport,
} from "./io.js";
import { createLoadReportRepository } from "./repository.js";

async function main(): Promise<void> {
  const config = loadLoadReportConfig();
  const generators = await Promise.all(
    config.generatorReportPaths.map(readGeneratorReport),
  );
  const ingestors = await Promise.all(
    config.ingestorReportPaths.map(readIngestorReport),
  );
  const database = createDatabase();
  try {
    const report = await createLoadTestReport(
      config.testId,
      generators,
      ingestors,
      createLoadReportRepository(database.db),
    );
    await writeLoadTestReport(config.outputPath, report);
    console.log(`負荷試験レポート: ${config.outputPath}`);
    console.log(
      `送信成功=${report.counters.sentSucceeded} MQTT受信=${report.counters.mqttReceived} DB保存=${report.counters.dbPersisted} 欠損=${report.counters.missing}`,
    );
    assertCompleteReport(report);
  } finally {
    await database.client.end();
  }
}

main().catch((error: unknown) => {
  console.error("負荷試験レポートの集約に失敗しました", error);
  process.exitCode = 1;
});
