import { createOtaRepository, type Database } from "@drone-fleet/database";

export function createOtaMonitor(
  db: Database,
  publish: (topic: string, payload: string, expiresAt: Date) => Promise<void>,
  repository = createOtaRepository(db),
) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    running: Promise<void> | undefined;
  async function runOnce() {
    const sends = await repository.tick();
    for (const send of sends) {
      if (stopped) break;
      try {
        await publish(send.topic, send.payload, send.expiresAt);
      } catch {
        /* 保存した同QUERYの再送だけを次回走査へ残す */
      }
    }
  }
  function loop() {
    if (stopped) return;
    running = runOnce()
      .catch(() => {
        console.error("OTA照会・評価の走査に失敗しました");
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, 1000);
      });
  }
  return {
    runOnce,
    start: loop,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
