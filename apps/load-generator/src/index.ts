import { loadLoadGeneratorConfig } from "./config.js";
import { runLoadGenerator } from "./generator.js";

async function main(): Promise<void> {
  const config = loadLoadGeneratorConfig();
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const report = await runLoadGenerator(config, {
      signal: controller.signal,
    });
    console.log(
      `負荷生成を終了しました（理由: ${report.stopReason}、成功: ${report.counters.succeeded}、失敗: ${report.counters.failed}）`,
    );
    console.log(`結果: ${config.reportPath}`);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  console.error("負荷生成に失敗しました", error);
  process.exitCode = 1;
});
