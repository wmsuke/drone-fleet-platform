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
}) {
  let device;
  const health = async () =>
    (await api(`/devices/${device}/bridge-health`)).body;
  async function start(id) {
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
  ]) {
    const command = await start(id);
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
  } finally {
    signal("SIGCONT");
  }
  await execution(node.id, ["FAILED"]);
  await duplicate(node);
  evidence.push({
    case: "ros-node-loss-does-not-imply-stop",
    commandId: node.id,
    executionCount: runtime().executionCount,
  });

  const generation = await start("ros-recovery-generation");
  const before = runtime();
  signal("SIGHUP");
  const changed = await execution(generation.id, ["UNCERTAIN"]);
  assert.equal(
    changed.events.find((e) => e.message.status === "UNCERTAIN")?.message
      .reason,
    "SERVER_CHANGED",
  );
  assert.equal(changed.target.stopConfirmed, false);
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
  });
  console.log(
    "Independent MQTT/DDS/node/Bridge/server faults, local constraints and no duplicate execution: passed",
  );
}
