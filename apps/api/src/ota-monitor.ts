import {
  createOtaRepository,
  createOtaRollout,
  createOtaRecovery,
  type Database,
} from "@drone-fleet/database";

export function createOtaMonitor(
  db: Database,
  publish: (topic: string, payload: string, expiresAt: Date) => Promise<void>,
  repository = createOtaRepository(db),
  recovery = createOtaRecovery(db),
) {
  const rollout = createOtaRollout(db);
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    running: Promise<void> | undefined;
  async function runOnce() {
    const sends = await repository.tick();
    // 評価で発動した停止をQUERY配送より先に処理する。
    for (const send of await rollout.tick()) {
      if (stopped) break;
      try {
        await rollout.deliver(send, publish);
      } catch {
        /* 同じIDの永続outboxだけを再送する */
      }
    }
    for (const send of sends) {
      if (stopped) break;
      try {
        await publish(send.topic, send.payload, send.expiresAt);
      } catch {
        /* 保存した同QUERYの再送だけを次回走査へ残す */
      }
    }
    for (const send of await recovery.tick()) {
      if (stopped) break;
      try {
        await recovery.deliver(send, publish);
      } catch {
        /* 同じ復旧attemptの配送再送だけを残す */
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
