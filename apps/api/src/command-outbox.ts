import type { createDatabase } from "@drone-fleet/database";

type Client = ReturnType<typeof createDatabase>["client"];
export interface OutboxOptions {
  pollMs: number;
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}
export function loadOutboxOptions(
  env: NodeJS.ProcessEnv = process.env,
): OutboxOptions {
  const read = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new TypeError(`${key} must be a positive integer`);
    return value;
  };
  const options = {
    pollMs: read("COMMAND_OUTBOX_POLL_MS", 250),
    baseMs: read("COMMAND_OUTBOX_RETRY_BASE_MS", 1000),
    maxMs: read("COMMAND_OUTBOX_RETRY_MAX_MS", 8000),
    maxAttempts: read("COMMAND_OUTBOX_MAX_ATTEMPTS", 5),
  };
  if (options.maxMs < options.baseMs)
    throw new TypeError(
      "COMMAND_OUTBOX_RETRY_MAX_MS must be >= COMMAND_OUTBOX_RETRY_BASE_MS",
    );
  return options;
}
export function retryDelay(
  attempt: number,
  options: OutboxOptions,
  random = Math.random,
): number {
  const cap = Math.min(
    options.maxMs,
    options.baseMs * 2 ** Math.min(attempt - 1, 30),
  );
  return Math.floor(cap / 2 + (random() * cap) / 2);
}

export function createCommandOutbox(
  client: Client,
  publish: (topic: string, payload: string, expiresAt: Date) => Promise<void>,
  options = loadOutboxOptions(),
  now = () => new Date(),
  random = Math.random,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  async function runOnce(): Promise<void> {
    const candidates = await client<
      { command_id: string }[]
    >`SELECT command_id FROM command_outbox WHERE state IN ('PENDING','WAITING_ACK') AND next_attempt_at <= ${now().toISOString()} ORDER BY next_attempt_at LIMIT 100`;
    for (const candidate of candidates) {
      if (stopped) break;
      const sql = await client.reserve();
      const transaction = async (work: (tx: typeof sql) => Promise<void>) => {
        await sql`BEGIN`;
        try {
          await work(sql);
          await sql`COMMIT`;
        } catch (error) {
          await sql`ROLLBACK`;
          throw error;
        }
      };
      let locked = false;
      try {
        const locks = await sql<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_lock(hashtextextended(${"command-outbox:" + candidate.command_id},0)) AS locked`;
        locked = locks[0]?.locked === true;
        if (!locked) continue;
        const rows = await sql<
          {
            topic: string;
            payload: string;
            expires_at: Date;
            attempts: number;
            published_at: Date | null;
            status: string;
            state: string;
            next_attempt_at: Date;
          }[]
        >`SELECT o.*, c.status FROM command_outbox o JOIN commands c USING(command_id) WHERE o.command_id=${candidate.command_id}`;
        const row = rows[0];
        if (row) {
          row.expires_at = new Date(row.expires_at);
          row.next_attempt_at = new Date(row.next_attempt_at);
        }
        const at = now();
        if (
          !row ||
          !["PENDING", "WAITING_ACK"].includes(row.state) ||
          row.next_attempt_at > at
        )
          continue;
        const terminal = [
          "ACKNOWLEDGED",
          "EXPIRED",
          "FAILED",
          "TIMED_OUT",
        ].includes(row.status);
        if (terminal || row.expires_at <= at) {
          const state = terminal
            ? row.status
            : row.attempts === 0
              ? "EXPIRED"
              : "TIMED_OUT";
          await transaction(async (tx) => {
            await tx`UPDATE commands SET status=${state}::command_status, expired_at=CASE WHEN ${state}='EXPIRED' THEN coalesce(expired_at,${at.toISOString()}) ELSE expired_at END, timed_out_at=CASE WHEN ${state}='TIMED_OUT' THEN coalesce(timed_out_at,${at.toISOString()}) ELSE timed_out_at END WHERE command_id=${candidate.command_id} AND status IN ('PENDING','SENT')`;
            await tx`UPDATE command_outbox o SET state=c.status::text, updated_at=${at.toISOString()} FROM commands c WHERE o.command_id=c.command_id AND o.command_id=${candidate.command_id}`;
          });
          continue;
        }
        if (row.attempts >= options.maxAttempts) {
          await sql`UPDATE command_outbox SET next_attempt_at=expires_at, state='WAITING_ACK', updated_at=${at.toISOString()} WHERE command_id=${candidate.command_id}`;
          continue;
        }
        const delay = retryDelay(row.attempts + 1, options, random);
        const next = new Date(
          Math.min(row.expires_at.getTime(), at.getTime() + delay),
        );
        // 試行を送信前にcommitする。クラッシュで送信済みの可能性を消さない。
        const claimed =
          await sql`UPDATE command_outbox o SET attempts=attempts+1, next_attempt_at=${next.toISOString()}, updated_at=${at.toISOString()} FROM commands c WHERE o.command_id=c.command_id AND o.command_id=${candidate.command_id} AND c.status IN ('PENDING','SENT') AND o.expires_at > ${now().toISOString()} RETURNING o.command_id`;
        if (claimed.length === 0) continue;
        let success = false;
        try {
          await publish(row.topic, row.payload, row.expires_at);
          success = true;
        } catch {
          /* 認証情報を含み得る送信エラーは保存しない。 */
        }
        await transaction(async (tx) => {
          if (success) {
            await tx`UPDATE commands SET status='SENT', sent_at=coalesce(sent_at,${now().toISOString()}) WHERE command_id=${candidate.command_id} AND status IN ('PENDING','SENT')`;
            await tx`UPDATE command_outbox SET published_at=coalesce(published_at,${now().toISOString()}) WHERE command_id=${candidate.command_id}`;
          } else {
            await tx`UPDATE command_outbox SET failures=failures+1 WHERE command_id=${candidate.command_id}`;
            if (
              row.attempts + 1 >= options.maxAttempts &&
              row.published_at === null
            )
              await tx`UPDATE commands SET status='FAILED' WHERE command_id=${candidate.command_id} AND status IN ('PENDING','SENT')`;
          }
          const nextAfterAttempt = new Date(
            Math.min(row.expires_at.getTime(), now().getTime() + delay),
          ).toISOString();
          await tx`UPDATE command_outbox o SET state=CASE WHEN c.status IN ('ACKNOWLEDGED','EXPIRED','FAILED','TIMED_OUT') THEN c.status::text WHEN o.attempts >= ${options.maxAttempts} THEN 'WAITING_ACK' ELSE 'PENDING' END, next_attempt_at=CASE WHEN o.attempts >= ${options.maxAttempts} THEN o.expires_at ELSE ${nextAfterAttempt}::timestamptz END, updated_at=${now().toISOString()} FROM commands c WHERE o.command_id=c.command_id AND o.command_id=${candidate.command_id}`;
        });
      } finally {
        try {
          if (locked)
            await sql`SELECT pg_advisory_unlock(hashtextextended(${"command-outbox:" + candidate.command_id},0))`;
        } finally {
          sql.release();
        }
      }
    }
  }
  async function tick() {
    try {
      await runOnce();
    } catch {
      console.error("command outboxの処理に失敗しました");
    }
    if (!stopped)
      timer = setTimeout(() => {
        running = tick();
      }, options.pollMs);
  }
  return {
    runOnce,
    start() {
      if (!running && !stopped) running = tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
    async status() {
      const rows =
        await client`SELECT count(*) FILTER (WHERE o.state IN ('PENDING','WAITING_ACK') AND c.status IN ('PENDING','SENT'))::int AS backlog, min(o.created_at) FILTER (WHERE o.state IN ('PENDING','WAITING_ACK') AND c.status IN ('PENDING','SENT')) AS oldest, coalesce(sum(o.attempts),0)::int AS attempts, coalesce(sum(o.failures),0)::int AS failures FROM command_outbox o JOIN commands c USING(command_id)`;
      return rows[0];
    },
  };
}
