import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function verifyNamespaceAndFeedback({
  api,
  compose,
  until,
  sql,
  publish,
  runtime,
  done,
  success,
  evidence,
  setPeer,
}) {
  const peer = "ros-command-before";
  evidence.begin("two-device-namespace-routing");
  setPeer(peer);
  compose("up", "-d", "--no-deps", "--force-recreate", "ros-bridge-peer");
  try {
    await until(
      async () =>
        (await api(`/devices/${peer}/bridge-configuration`)).body.ready,
      "second namespace ready",
    );
    const before = runtime(undefined, peer);
    assert.equal(before.executionCount, 0);
    publish("commands", success.wire, peer); // 本文はA、配送topicだけBへ誤配送する。
    const peerJournal = () =>
      JSON.parse(
        compose(
          "exec",
          "-T",
          "ros-bridge-peer",
          "python3",
          "-c",
          "import sqlite3,json,os;d=sqlite3.connect(os.environ['BRIDGE_STATE_DIR']+'/bridge.sqlite3');print(json.dumps({'goals':d.execute('SELECT count(*) FROM action_commands').fetchone()[0],'quarantined':d.execute(\"SELECT count(*) FROM inbox WHERE reason='QUARANTINED_COMMAND'\").fetchone()[0]}))",
        ),
      );
    await until(
      () => peerJournal().quarantined === 1,
      "wrong-device command quarantined by B",
    );
    assert.equal(peerJournal().goals, 0);
    const after = runtime(undefined, peer);
    assert.equal(after.executionCount, 0);
    assert.equal(after.acceptedCount, 0);
    assert.equal(runtime().executionCount, 1);
    assert.equal(
      sql(`SELECT count(*) FROM ros_command_targets WHERE device_id='${peer}'`),
      "0",
    );
    const a = (await api(`/devices/${success.wire.deviceId}`)).body
      .latestObservation.message;
    const b = (await api(`/devices/${peer}`)).body.latestObservation.message;
    assert.equal(a.deviceId, success.wire.deviceId);
    assert.equal(b.deviceId, peer);
    assert.notEqual(a.payload.position.frameId, b.payload.position.frameId);
    evidence.push({
      case: "two-device-namespace-routing",
      commandId: success.id,
      goalId: done.target.goalId,
      devices: [a.deviceId, b.deviceId],
      frames: [a.payload.position.frameId, b.payload.position.frameId],
      peerAcceptedCount: after.acceptedCount,
      peerExecutionCount: after.executionCount,
      peerJournal: peerJournal(),
    });
  } finally {
    compose("stop", "ros-bridge-peer");
    compose("rm", "-f", "ros-bridge-peer");
    setPeer("ros-command-reject");
  }

  const original = done.events.find((e) => e.message.kind === "FEEDBACK");
  evidence.begin("delayed-feedback-does-not-rewind-terminal");
  assert(original);
  const dds = JSON.parse(
    compose(
      "exec",
      "-T",
      "-e",
      "BRIDGE_INTEGRATION=true",
      "ros-reference",
      "bash",
      "/workspace/tools/entrypoint.sh",
      "python3",
      "/workspace/tools/replay_feedback.py",
      JSON.stringify({
        ...original.message,
        adapterConfigurationId: done.configuration.adapterConfigurationId,
      }),
    ),
  );
  assert(dds.subscribers >= 1);
  assert.equal(dds.published, 3);
  const delayed = { ...original.message, eventId: randomUUID() };
  publish("bridge-events", delayed);
  const after = await until(async () => {
    const r = (await api(`/commands/${success.id}/bridge-execution`)).body;
    return r.events.some(
      (e) => e.eventId === delayed.eventId && e.disposition === "STALE",
    )
      ? r
      : false;
  }, "late feedback retained without rewinding terminal");
  assert.equal(after.command.executionStatus, "SUCCEEDED");
  assert.equal(after.target.terminalEventId, done.target.terminalEventId);
  assert.equal(after.target.stopConfirmed, true);
  assert.equal(runtime().executionCount, 1);
  evidence.push({
    case: "delayed-feedback-does-not-rewind-terminal",
    commandId: success.id,
    goalId: done.target.goalId,
    sourceEventId: original.eventId,
    delayedEventId: delayed.eventId,
    dds,
    executionCount: 1,
    terminalEventId: after.target.terminalEventId,
  });
}

export function reconcile(sql) {
  const commands = JSON.parse(
    sql(
      `SELECT coalesce(json_agg(x),'[]') FROM (SELECT c.command_id,c.device_id,c.execution_status,c.execution_started_at,c.execution_result_at,t.goal_id,t.configuration_id,t.report_event_id,t.stop_confirmed,t.not_started,t.conflicted,b.goal_id AS bound_goal,b.configuration_id AS bound_configuration,b.report_event_id AS bound_report,(SELECT count(*) FROM bridge_configurations f WHERE f.configuration_id=t.configuration_id) AS snapshot_count,(SELECT count(*) FROM bridge_action_events e WHERE e.command_id=c.command_id AND e.disposition='APPLIED' AND e.message->>'kind'='EXECUTION' AND e.message->>'status' IN ('SUCCEEDED','FAILED','CANCELLED')) AS terminal_count FROM ros_command_targets t JOIN commands c USING(command_id) LEFT JOIN bridge_command_configurations b USING(command_id) ORDER BY c.created_at) x`,
    ),
  );
  assert(commands.length > 0);
  const goals = new Set();
  for (const row of commands) {
    assert.equal(row.snapshot_count, 1);
    if (row.goal_id) {
      assert(
        !goals.has(row.goal_id),
        "goal UUID assigned to multiple commands",
      );
      goals.add(row.goal_id);
    }
    if (row.execution_started_at) {
      assert.equal(row.bound_goal, row.goal_id);
      assert.equal(row.bound_configuration, row.configuration_id);
      assert.equal(row.bound_report, row.report_event_id);
    } else assert.equal(row.bound_goal, null);
    assert(row.terminal_count <= 1);
  }
  const interventions = JSON.parse(
    sql(
      `SELECT coalesce(json_agg(x),'[]') FROM (SELECT r.cancel_id,r.command_id,r.intervention_id,r.phase,r.assessment,r.attempts,r.published_at,(SELECT count(*) FROM ros_command_cancels c WHERE c.command_id=r.command_id) AS request_count,(SELECT count(*) FROM audit_logs a WHERE a.command_id=r.command_id AND a.action='command.cancel_requested' AND a.metadata->>'interventionId'=r.intervention_id::text) AS audit_count FROM ros_command_cancels r ORDER BY r.created_at) x`,
    ),
  );
  assert(interventions.length > 0);
  for (const row of interventions) {
    assert.equal(row.request_count, 1);
    assert.equal(row.audit_count, 1);
    assert(row.attempts >= 0 && row.attempts <= 3);
  }
  return {
    verified: true,
    commands,
    interventions,
    commandCount: commands.length,
    deviceCount: new Set(commands.map((r) => r.device_id)).size,
    distinctGoalCount: goals.size,
    configurationBindings: commands.filter((r) => r.bound_goal).length,
    resultCount: commands.reduce((n, r) => n + Number(r.terminal_count), 0),
    interventionCount: interventions.length,
  };
}
