import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import console from "node:console";

export async function verifyRecovery({
  api,
  send,
  switchDevice,
  execution,
  compose,
  until,
  sql,
  publish,
  evidence,
  kill,
  restart,
  runtime,
  extended = false,
  runUi,
}) {
  let device;
  const health = async () =>
    (await api(`/devices/${device}/bridge-health`)).body;
  async function start(id, name) {
    evidence.begin(
      name ??
        {
          "ros-recovery-dds":
            "dds-only-outage-watchdog-result-without-fabricated-stop",
          "ros-recovery-bridge": "bridge-restart-queries-original-goal",
          "ros-recovery-node": "ros-node-loss-does-not-imply-stop",
          "ros-recovery-generation": "action-server-restart-no-goal-resubmit",
        }[id],
    );
    device = id;
    console.log(`Recovery E2E: ${device}`);
    await switchDevice(device);
    const command = await send();
    await until(
      async () =>
        (await api(`/commands/${command.id}/bridge-execution`)).body?.target
          ?.acceptedAt,
      "actual recovery goal accepted",
    );
    return command;
  }
  const local = (code) =>
    compose("exec", "-T", "ros-bridge", "python3", "-c", code);
  const state = (id) =>
    JSON.parse(
      local(
        `import sqlite3,json;d=sqlite3.connect('/data/fleet/${device}/bridge.sqlite3');print(json.dumps(d.execute('SELECT state,result FROM action_commands WHERE command=?',('${id}',)).fetchone()))`,
      ),
    );
  const duplicate = async (command) => {
    publish("commands", command.wire);
    await setTimeout(1000);
    assert.equal(runtime().acceptedCount, 1);
    assert.equal(runtime().executionCount, 1);
    assert.equal(
      sql(
        `SELECT count(*) FROM ros_command_targets WHERE command_id='${command.id}'`,
      ),
      "1",
    );
  };
  for (const [id, expected, reason] of [
    ["ros-recovery-mqtt", "SUCCEEDED", "HOME_REACHED"],
    ["ros-recovery-battery", "FAILED", "LOW_BATTERY"],
    ...(extended
      ? [
          ["ros-recovery-policy", "FAILED", "POLICY_REJECTED"],
          ["ros-recovery-sensor", "FAILED", "SENSOR_STALE"],
        ]
      : []),
  ]) {
    const command = await start(id, `mqtt-outage-${reason}`);
    compose("stop", "mqtt");
    try {
      await until(
        () => state(command.id)?.[0] === expected,
        "local result while broker stopped",
        15,
      );
      const result = JSON.parse(state(command.id)[1]);
      assert.equal(result.reason, reason);
      const cloud = (await api(`/commands/${command.id}/bridge-execution`))
        .body;
      assert.notEqual(cloud.command.executionStatus, expected);
      assert.equal(cloud.target.stopConfirmed, false);
    } finally {
      compose("start", "mqtt");
    }
    const result = await execution(command.id, [expected]);
    assert(result.events.some((e) => e.message.reason === reason));
    await duplicate(command);
    await until(
      async () => (await health()).events.some((e) => !e.message.mqttConnected),
      "stored MQTT-only outage",
    );
    evidence.push({
      case: `mqtt-outage-${reason}`,
      commandId: command.id,
      goalId: result.target.goalId,
      executionCount: runtime().executionCount,
    });
  }
  const dds = await start("ros-recovery-dds");
  local("from pathlib import Path;Path('/data/fleet/dds-cutoff').touch()");
  try {
    await until(
      async () => {
        const h = await health();
        return (
          h.fresh &&
          h.latest.message.rosAvailable === false &&
          h.latest.message.mqttConnected
        );
      },
      "DDS unavailable while MQTT remains connected",
      15,
    );
    const cloud = (await api(`/commands/${dds.id}/bridge-execution`)).body;
    assert.notEqual(cloud.command.executionStatus, "FAILED");
    assert.equal(cloud.target.stopConfirmed, false);
    assert.equal(
      (await api(`/devices/${device}/commands`, { type: "RETURN_HOME" }))
        .status,
      409,
    );
    await setTimeout(9000);
  } finally {
    local(
      "from pathlib import Path;Path('/data/fleet/dds-cutoff').unlink(missing_ok=True)",
    );
  }
  const stopped = await execution(dds.id, ["FAILED"]);
  assert(stopped.events.some((e) => e.message.reason === "BRIDGE_WATCHDOG"));
  assert.equal(stopped.target.stopConfirmed, false); // 遮断中に終わった古い観測から停止を補完しない。
  assert.equal(stopped.recovery.humanReviewRequired, true);
  assert.equal(
    (await api(`/devices/${device}/commands`, { type: "RETURN_HOME" })).status,
    409,
  );
  await duplicate(dds);
  evidence.push({
    case: "dds-only-outage-watchdog-result-without-fabricated-stop",
    commandId: dds.id,
    goalId: stopped.target.goalId,
    executionCount: runtime().executionCount,
  });

  const bridge = await start("ros-recovery-bridge");
  const original = runtime();
  kill();
  await setTimeout(4000);
  assert.equal(runtime().hasActiveGoal, false);
  await restart();
  const resumed = await execution(bridge.id, ["FAILED"]);
  assert(resumed.events.some((e) => e.message.reason === "BRIDGE_WATCHDOG"));
  assert.equal(runtime().serverInstanceId, original.serverInstanceId);
  await duplicate(bridge);
  evidence.push({
    case: "bridge-restart-queries-original-goal",
    commandId: bridge.id,
    goalId: resumed.target.goalId,
    executionCount: runtime().executionCount,
  });

  // processごとのnode喪失とAction server世代喪失を、DDS packet遮断とは別に注入する。
  const signal = (name) =>
    compose(
      "exec",
      "-T",
      "ros-reference",
      "python3",
      "/workspace/tools/signal_reference.py",
      name,
    );
  const node = await start("ros-recovery-node");
  signal("SIGSTOP");
  try {
    await until(
      async () => (await health()).latest?.message.rosAvailable === false,
      "ROS node loss",
      15,
    );
    const cloud = (await api(`/commands/${node.id}/bridge-execution`)).body;
    assert.equal(cloud.target.stopConfirmed, false);
    assert.notEqual(cloud.command.executionStatus, "FAILED");
    assert.equal(
      (await api(`/devices/${device}/commands`, { type: "RETURN_HOME" }))
        .status,
      409,
    );
  } finally {
    signal("SIGCONT");
  }
  await until(
    async () => (await health()).latest?.message.rosAvailable === true,
    "ROS node available again",
    15,
  );
  await duplicate(node);
  // 再開時のheartbeatとwatchdogの順序で、元のgoalは継続または実結果で終了する。
  // node喪失だけを根拠にFAILEDや停止確認を要求しない。
  const nodeResult = (await api(`/commands/${node.id}/bridge-execution`)).body;
  if (nodeResult.command.executionStatus === "FAILED") {
    assert(
      nodeResult.events.some((e) => e.message.reason === "BRIDGE_WATCHDOG"),
    );
  } else {
    assert.equal(nodeResult.target.stopConfirmed, false);
    assert.equal(
      (await api(`/devices/${device}/commands`, { type: "RETURN_HOME" }))
        .status,
      409,
    );
  }
  evidence.push({
    case: "ros-node-loss-does-not-imply-stop",
    commandId: node.id,
    executionStatus: nodeResult.command.executionStatus,
    executionCount: runtime().executionCount,
  });

  evidence.begin("action-server-restart-no-goal-resubmit");
  device = "ros-recovery-generation";
  await switchDevice(device);
  const generation = await send();
  // 実execute開始時に参照process自身がSIGSTOPする。DDS probeの待機中に
  // watchdog終端へ到達しない。閾値は変更せず、停止したprocessを実際に失う。
  const before = await until(
    () => {
      const proof = JSON.parse(
        compose(
          "exec",
          "-T",
          "ros-reference",
          "python3",
          "-c",
          "import json;from pathlib import Path;p=Path('/tmp/fleet-reference-execution-barrier.json');m=json.loads(p.read_text()) if p.exists() else None;print(json.dumps(dict(m,stopped=any(l.startswith('State:') and l.split()[1] in ('T','t') for l in Path('/proc/'+str(m['pid'])+'/status').read_text().splitlines())) if m else None))",
        ),
      );
      return proof?.commandId === generation.id && proof.stopped
        ? proof
        : false;
    },
    "actual execution barrier and stopped server",
    15,
  );
  assert.equal(before.deviceId, device);
  assert.equal(before.rosStatus, 2); // 実ROS GoalStatus.EXECUTING
  assert.equal(before.acceptedCount, 1);
  assert.equal(before.executionCount, 1);
  assert.equal(before.hasTerminal, false);
  const pending = (await api(`/commands/${generation.id}/bridge-execution`))
    .body;
  assert.equal(pending.target.terminalEventId, null);
  assert.equal(pending.target.stopConfirmed, false);
  signal("SIGHUP");
  const changed = await execution(generation.id, ["UNCERTAIN"]);
  assert.equal(
    changed.events.find((e) => e.message.status === "UNCERTAIN")?.message
      .reason,
    "SERVER_CHANGED",
  );
  assert.equal(changed.target.stopConfirmed, false);
  assert.equal(changed.target.goalId, before.goalId);
  assert.equal(changed.recovery.humanReviewRequired, true);
  await until(
    () => runtime().serverInstanceId !== before.serverInstanceId,
    "actual server generation changed",
  );
  assert.equal(runtime().executionCount, 0);
  publish("commands", generation.wire);
  assert.equal(
    (await api(`/devices/${device}/commands`, { type: "RETURN_HOME" })).status,
    409,
  );
  await setTimeout(1000);
  assert.equal(runtime().executionCount, 0);
  evidence.push({
    case: "action-server-restart-no-goal-resubmit",
    commandId: generation.id,
    oldServer: before.serverInstanceId,
    newServer: runtime().serverInstanceId,
    executionCount: 0,
    executionBarrier: before,
  });
  if (runUi) await runUi("uncertain", generation.id, device);

  const terminal = await start(
    "ros-recovery-terminal",
    "terminal-before-server-restart-preserved",
  );
  const saved = await execution(terminal.id, ["FAILED"], true);
  const event = saved.events.find(
    (e) => e.eventId === saved.target.terminalEventId,
  );
  assert.equal(event.message.reason, "INJECTED_FAILURE");
  assert.equal(event.disposition, "APPLIED");
  const oldServer = saved.configuration.serverInstanceId;
  signal("SIGHUP");
  const currentServer = await until(() => {
    const r = runtime();
    return r.serverInstanceId !== oldServer ? r : false;
  }, "terminal case server changed");
  await until(async () => {
    const report = (await api(`/devices/${device}/bridge-configuration`)).body
      .reported;
    const h = await health();
    return (
      report?.configuration.serverInstanceId ===
        currentServer.serverInstanceId &&
      h.fresh &&
      h.latest?.message.serverInstanceId === currentServer.serverInstanceId
    );
  }, "new server configuration and health");
  publish("commands", terminal.wire);
  await setTimeout(1000);
  const retained = (await api(`/commands/${terminal.id}/bridge-execution`))
    .body;
  assert.equal(retained.command.executionStatus, "FAILED");
  assert.equal(retained.target.goalId, saved.target.goalId);
  assert.equal(retained.target.terminalEventId, saved.target.terminalEventId);
  assert.equal(retained.target.stopConfirmed, true);
  assert.equal(retained.target.conflicted, false);
  assert.deepEqual(retained.configuration, saved.configuration);
  assert.deepEqual(
    retained.events.find((e) => e.eventId === event.eventId).message,
    event.message,
  );
  assert.equal(
    retained.events.filter(
      (e) =>
        e.disposition === "APPLIED" &&
        e.message.kind === "EXECUTION" &&
        ["FAILED", "SUCCEEDED", "CANCELLED"].includes(e.message.status),
    ).length,
    1,
  );
  const fresh = runtime();
  assert.equal(fresh.acceptedCount, 0);
  assert.equal(fresh.executionCount, 0);
  evidence.push({
    case: "terminal-before-server-restart-preserved",
    commandId: terminal.id,
    goalId: saved.target.goalId,
    terminalEventId: event.eventId,
    resultHash: event.message.result.hash,
    oldServer,
    newServer: fresh.serverInstanceId,
    executionCount: fresh.executionCount,
  });
  console.log(
    "Independent MQTT/DDS/node/Bridge/server faults, local constraints and no duplicate execution: passed",
  );
}
