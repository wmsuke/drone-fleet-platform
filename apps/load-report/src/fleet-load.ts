import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import {
  createDatabase,
  devices,
  groups,
  groupMemberships,
  type Database,
} from "@drone-fleet/database";
import { runApiProbe } from "./api-probe.js";
import { writeJsonReport } from "./io.js";

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (ratio: number) =>
    sorted[Math.ceil(sorted.length * ratio) - 1] ?? null;
  return {
    count: sorted.length,
    minMs: sorted[0] ?? null,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    p99Ms: p(0.99),
    maxMs: sorted.at(-1) ?? null,
  };
}
export function assessFleet(
  count: number,
  acceptMs: number,
  api: Awaited<ReturnType<typeof runApiProbe>>,
  rows: { targets: number; commands: number; outboxes: number },
) {
  return {
    acceptance: acceptMs <= 5000,
    detailLatency: api.timings.p95Ms !== null && api.timings.p95Ms < 500,
    apiErrors: api.counters.attempted > 0 && api.errorRate < 0.01,
    noMissingRows: Object.values(rows).every((value) => value === count),
    noTimeouts: api.counters.timedOut === 0,
  };
}
export function expectedOutcome(
  count: number,
  condition: string,
  operation: { status: string; counts: Record<string, number> } | undefined,
) {
  if (!operation) return false;
  const affected = condition === "success" ? 0 : count / 10;
  return (
    operation.status === (affected ? "PARTIALLY_FAILED" : "COMPLETED") &&
    operation.counts.SUCCEEDED === count - affected &&
    (operation.counts.EXECUTION_FAILED ?? 0) ===
      (condition === "failure" ? affected : 0) &&
    (operation.counts.UNRESPONSIVE ?? 0) ===
      (condition === "unresponsive" ? affected : 0)
  );
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  if (
    process.env.POSTGRES_HOST !== "postgres" ||
    process.env.FLEET_LOAD_API !== "http://api:3000"
  )
    throw new Error("dedicated local Compose only");
  const count = Number(process.env.FLEET_LOAD_DEVICES ?? 100);
  if (![10, 100, 1000].includes(count)) throw new Error("invalid count");
  const prefix = process.env.FLEET_LOAD_PREFIX ?? "fleetload";
  const condition = process.env.FLEET_LOAD_CONDITION;
  if (!["success", "failure", "unresponsive"].includes(condition ?? ""))
    throw new Error("invalid condition");
  const { client, db } = createDatabase();
  try {
    const groupId = randomUUID();
    const ids = Array.from(
      { length: count },
      (_, i) => `${prefix}-${String(i + 1).padStart(4, "0")}`,
    );
    await db.insert(devices).values(ids.map((deviceId) => ({ deviceId })));
    await db.insert(groups).values({ groupId, name: "command負荷検証" });
    await db
      .insert(groupMemberships)
      .values(ids.map((deviceId) => ({ groupId, deviceId })));
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const response = await fetch("http://api:3000/fleet-operations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ groupId, type: "RETURN_HOME" }),
      signal: AbortSignal.timeout(15000),
    });
    const accepted = (await response.json()) as { operationId: string };
    const acceptanceMs = performance.now() - start;
    if (response.status !== 202 || !accepted.operationId)
      throw new Error("operation rejected");
    const operationId = accepted.operationId;
    const samples: unknown[] = [];
    let operation:
      | { status: string; counts: Record<string, number> }
      | undefined;
    let terminalObservedMs: number | null = null;
    let samplingError: string | null = null;
    let stop = false;
    const sample = async () => {
      while (!stop) {
        try {
          const [row] = await client`SELECT
            count(*) FILTER (WHERE c.status IN ('PENDING','SENT'))::int AS backlog,
            count(*) FILTER (WHERE b.published_at IS NOT NULL)::int AS published,
            count(*) FILTER (WHERE c.acknowledgement_received_at IS NOT NULL)::int AS acknowledged,
            count(*) FILTER (WHERE c.execution_status IN ('SUCCEEDED','FAILED'))::int AS finished,
            (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,
            (SELECT count(*)::int FROM pg_locks WHERE NOT granted) AS waiting_locks
            FROM fleet_operation_targets t JOIN commands c USING(command_id) JOIN command_outbox b USING(command_id)
            WHERE t.operation_id=${operationId}`;
          samples.push({ at: new Date().toISOString(), ...row });
        } catch {
          samplingError = "DB sampling failed";
        }
        await wait(500);
      }
    };
    const sampling = sample();
    const monitor = (async () => {
      while (!stop) {
        try {
          const r = await fetch(
            `http://api:3000/fleet-operations/${operationId}`,
            { signal: AbortSignal.timeout(2000) },
          );
          if (r.ok) {
            operation = (await r.json()) as typeof operation;
            if (
              operation &&
              ["COMPLETED", "PARTIALLY_FAILED", "FAILED"].includes(
                operation.status,
              ) &&
              terminalObservedMs === null
            )
              terminalObservedMs = performance.now() - start;
          }
        } catch {
          /* API probe側でerror/timeout率を計測する。 */
        }
        await wait(500);
      }
    })();
    // 成功・失敗も10秒間観測し、未応答は実際の30秒開始期限を待つ。
    const durationMs = condition === "unresponsive" ? 35000 : 10000;
    const api = await runApiProbe({
      testId: prefix,
      targetUrl: `http://api:3000/fleet-operations/${operationId}?limit=100&offset=0`,
      durationMs,
      intervalMs: 100,
      timeoutMs: 2000,
    });
    stop = true;
    await Promise.all([sampling, monitor]);
    const rows =
      await client`SELECT t.device_id,c.command_id,c.created_at,c.acknowledgement_received_at,c.execution_result_received_at,b.published_at,b.attempts,b.failures,b.state
      FROM fleet_operation_targets t JOIN commands c USING(command_id) JOIN command_outbox b USING(command_id) WHERE t.operation_id=${operationId}`;
    const counts = {
      targets: rows.length,
      commands: new Set(rows.map((r) => r.command_id)).size,
      outboxes: rows.filter((r) => r.state).length,
    };
    const [totals] =
      await client`SELECT (SELECT count(*)::int FROM devices) AS devices,(SELECT count(*)::int FROM fleet_operations) AS operations,(SELECT count(*)::int FROM fleet_operation_targets) AS targets,(SELECT count(*)::int FROM commands) AS commands,(SELECT count(*)::int FROM command_outbox) AS outboxes,(SELECT count(*)::int FROM command_execution_events) AS execution_events,(SELECT count(*)::int FROM audit_logs) AS audit_logs`;
    const ackMs = rows
      .filter((r) => r.acknowledgement_received_at)
      .map(
        (r) =>
          new Date(r.acknowledgement_received_at).getTime() -
          new Date(r.created_at).getTime(),
      );
    const published = rows
      .filter((r) => r.published_at)
      .map(
        (r) =>
          new Date(r.published_at).getTime() - new Date(r.created_at).getTime(),
      );
    const modulePath = pathToFileURL(
      resolve("apps/api/dist/fleet-operation-query.js"),
    ).href;
    const { operationDetailStatement } = (await import(modulePath)) as {
      operationDetailStatement: (
        id: string,
        q: { limit: number; offset: number },
        now: Date,
      ) => SQL;
    };
    await db.execute(sql`ANALYZE`);
    const plan = await (db as Database).execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${operationDetailStatement(operationId, { limit: 100, offset: 0 }, new Date())}`,
    );
    const [connections] =
      await client`SELECT max_conn.setting AS max_connections, db_stats.numbackends,db_stats.deadlocks FROM pg_stat_database db_stats CROSS JOIN pg_settings max_conn WHERE db_stats.datname=current_database() AND max_conn.name='max_connections'`;
    const report = {
      schemaVersion: 1,
      startedAt,
      endedAt: new Date().toISOString(),
      count,
      condition,
      operationId,
      acceptanceMs,
      api,
      terminalObservedMs,
      operation,
      rows: counts,
      commandTimelines: rows,
      tableCounts: totals,
      connections,
      samplingError,
      samples,
      publish: {
        unique: published.length,
        completionMs: Math.max(...published),
        uniquePerSecond: published.length / (Math.max(...published) / 1000),
        latency: distribution(published),
        attempts: rows.reduce((n, r) => n + Number(r.attempts), 0),
        failures: rows.reduce((n, r) => n + Number(r.failures), 0),
      },
      acknowledgementFromCreationMs: distribution(ackMs),
      checks: {
        ...assessFleet(count, acceptanceMs, api, counts),
        expectedOutcome: expectedOutcome(count, condition!, operation),
      },
      runtime: {
        node: process.version,
        postgres: (await client`SELECT version()`)[0]?.version,
      },
      plan,
    };
    await writeJsonReport("/workspace/load-results/trial.json", report);
    console.log(
      JSON.stringify({
        count,
        condition,
        acceptanceMs,
        p95: api.timings.p95Ms,
        terminalObservedMs,
        checks: report.checks,
      }),
    );
    if (
      samplingError ||
      terminalObservedMs === null ||
      Object.values(report.checks).some((v) => !v)
    )
      process.exitCode = 1;
  } finally {
    await client.end();
  }
}
if (process.argv[1]?.endsWith("fleet-load.js"))
  main().catch(() => {
    console.error("複数機体commandの負荷計測に失敗しました");
    process.exitCode = 1;
  });
