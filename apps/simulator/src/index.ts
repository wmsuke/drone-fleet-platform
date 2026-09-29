import { loadSimulatorConfig } from "./config.js";
import { startSimulatorFleet } from "./fleet.js";

async function main(): Promise<void> {
  const config = loadSimulatorConfig();
  const fleet = await startSimulatorFleet(config);

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    console.log(`${signal}を受信したためシミュレータを停止します`);

    try {
      await fleet.shutdown();
      process.exitCode = 0;
    } catch (error) {
      console.error("シミュレータの停止に失敗しました", error);
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("シミュレータの起動に失敗しました", error);
  process.exitCode = 1;
});
