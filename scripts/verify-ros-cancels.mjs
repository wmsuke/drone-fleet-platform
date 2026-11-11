// 実Actionの中断応答と終端・停止を、MQTT/DB/APIを通して別々に検証する。
import assert from "node:assert/strict";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
export async function verifyCancellations({
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
  barrier,
  runUi,
}) {
  let current;
  const state = async (id) =>
    (await api(`/devices/${current}/commands/${id}/cancel`)).body;
  const path = (id) => `/devices/${current}/commands/${id}/cancel`;
  const post = (id, key, reason = "OPERATOR_REQUEST") =>
    api(
      path(id),
      { reason },
      {
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      },
    );
  async function start(device, fault = "", requireRunning = true) {
    evidence.begin(
      {
        "ros-cancel-normal":
          "cancel-accepted-not-terminal-then-cancelled-and-stop",
        "ros-cancel-reject": "cancel-rejected-preserves-later-success",
        "ros-cancel-race": "completion-wins-delayed-cancel",
        "ros-cancel-timeout":
          "cancel-accepted-without-terminal-remains-uncertain",
        "ros-cancel-offline":
          "offline-request-expiry-late-response-and-restart",
        "ros-cancel-unknown": "actual-unknown-goal-response",
      }[device],
    );
    console.log(`Cancel E2E: ${device}`);
    current = device;
    await switchDevice(device, fault);
    const command = await send();
    await until(async () => {
      const r = await api(`/commands/${command.id}/bridge-execution`);
      return (
        r.body?.target?.acceptedAt &&
        (!requireRunning || r.body.command.executionStatus === "RUNNING")
      );
    }, "actual goal accepted/running");
    return command;
  }
  const normal = await start("ros-cancel-normal", "", false),
    key = randomUUID();
  assert.equal(
    (await api(path(normal.id), { reason: "OPERATOR_REQUEST" })).status,
    400,
  );
  const accepted = await post(normal.id, key);
  assert.equal(accepted.status, 202, JSON.stringify(accepted));
  const pending = await until(async () => {
    const r = await state(normal.id);
    return r.phase === "ACCEPTED" ? r : false;
  }, "cancel accepted before terminal");
  // 通常中断は実終端まで進める。HTTPで観測する前に終了しても異常ではない。
  assert.equal(pending.cancelId, accepted.body.cancelId);
  const duplicate = await post(normal.id, key);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.cancelId, accepted.body.cancelId);
  assert.equal((await post(normal.id, key, "DIFFERENT_REASON")).status, 409);
  assert.equal((await post(normal.id, randomUUID())).status, 409);
  const cancelled = await execution(normal.id, ["CANCELLED"], true);
  const confirmed = await until(async () => {
    const r = await state(normal.id);
    return r.assessment === "CANCELLED" ? r : false;
  }, "cancel terminal plus stop");
  assert.equal(confirmed.stopConfirmation, "OBSERVED");
  assert.equal(confirmed.actorKind, "anonymous");
  assert.equal(confirmed.actorId, null);
  assert(
    cancelled.events.some(
      (e) =>
        e.message.kind === "EXECUTION" && e.message.result?.rosStatus === 5,
    ),
  );
  publish("bridge-requests", accepted.body.state.request);
  const original = confirmed.events.find((e) => e.message.phase === "ACCEPTED");
  publish("bridge-events", original.message);
  const replay = await post(normal.id, key);
  assert.equal(replay.body.cancelId, accepted.body.cancelId);
  assert.equal(
    sql(
      `SELECT count(*) FROM ros_command_cancels WHERE command_id='${normal.id}'`,
    ),
    "1",
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM audit_logs WHERE command_id='${normal.id}' AND action='command.cancel_requested'`,
    ),
    "1",
  );
  evidence.push({
    case: "cancel-accepted-not-terminal-then-cancelled-and-stop",
    commandId: normal.id,
    cancelId: accepted.body.cancelId,
    terminalStatus: confirmed.terminalStatus,
    stopConfirmation: confirmed.stopConfirmation,
  });
  if (runUi) await runUi("cancel", normal.id, current);

  const reject = await start("ros-cancel-reject");
  const rejectedRequest = await post(reject.id, randomUUID());
  assert.equal(rejectedRequest.status, 202);
  const rejected = await until(async () => {
    const r = await state(reject.id);
    return r.phase === "REJECTED" ? r : false;
  }, "actual cancel rejection");
  assert(
    rejected.events.some(
      (e) =>
        e.message.reason === "NO_GOAL_CANCELING" &&
        e.message.response?.returnCode === 0 &&
        e.message.response.goalsCanceling.length === 0,
    ),
  );
  assert.notEqual(rejected.terminalStatus, "CANCELLED");
  await execution(reject.id, ["SUCCEEDED"], true);
  assert.equal((await state(reject.id)).terminalStatus, "SUCCEEDED");
  evidence.push({
    case: "cancel-rejected-preserves-later-success",
    commandId: reject.id,
    cancelId: rejected.cancelId,
  });

  const race = await start("ros-cancel-race");
  const racing = await post(race.id, randomUUID());
  assert.equal(racing.status, 202);
  await until(
    async () => (await state(race.id)).phase === "ACCEPTED",
    "delayed cancel accepted",
  );
  await execution(race.id, ["SUCCEEDED"], true);
  const raced = await until(async () => {
    const r = await state(race.id);
    return r.assessment === "COMPLETED" ? r : false;
  }, "success wins delayed cancellation");
  assert.equal(raced.terminalStatus, "SUCCEEDED");
  evidence.push({
    case: "completion-wins-delayed-cancel",
    commandId: race.id,
    cancelId: racing.body.cancelId,
  });

  const timeout = await start("ros-cancel-timeout", "", false);
  const timing = await post(timeout.id, randomUUID());
  assert.equal(timing.status, 202);
  const acceptedOnly = await until(async () => {
    const r = await state(timeout.id);
    return r.phase === "ACCEPTED" ? r : false;
  }, "unresponsive goal accepts cancel");
  assert.equal(acceptedOnly.assessment, "PENDING");
  assert.equal(acceptedOnly.stopConfirmation, "UNKNOWN");
  assert.notEqual(acceptedOnly.terminalStatus, "CANCELLED");
  const unknown = await until(
    async () => {
      const r = await state(timeout.id);
      return r.assessment === "UNCERTAIN" ? r : false;
    },
    "cancel ten-second uncertainty",
    20,
  );
  assert.equal(unknown.humanReviewRequired, true);
  assert.equal(unknown.stopConfirmation, "UNKNOWN");
  assert.notEqual(unknown.terminalStatus, "CANCELLED");
  assert.equal(
    (await api(`/devices/${current}/commands`, { type: "RETURN_HOME" })).status,
    409,
  );
  evidence.push({
    case: "cancel-accepted-without-terminal-remains-uncertain",
    commandId: timeout.id,
    cancelId: timing.body.cancelId,
  });

  const offline = await start("ros-cancel-offline", "", false);
  kill();
  const offlineKey = randomUUID();
  const missed = await post(offline.id, offlineKey);
  assert.equal(missed.status, 202);
  await until(
    async () => (await state(offline.id)).assessment === "UNCERTAIN",
    "offline cancel expires",
    20,
  );
  const old = await state(offline.id);
  assert(old.attempts <= 3);
  await restart();
  await until(async () => {
    const r = await state(offline.id);
    return r.events.some((e) => e.disposition === "LATE");
  }, "late request receipt after restart");
  assert.equal((await state(offline.id)).assessment, "UNCERTAIN");
  assert.equal(
    (await post(offline.id, offlineKey)).body.cancelId,
    missed.body.cancelId,
  );
  evidence.push({
    case: "offline-request-expiry-late-response-and-restart",
    commandId: offline.id,
    cancelId: missed.body.cancelId,
    attempts: old.attempts,
  });

  // resultを端末で保存した直後に止め、Cloudに終端が未着の間に同goalを中断する。
  const missing = await start("ros-cancel-unknown", "AFTER_RESULT");
  await barrier(missing.id);
  compose("pause", "telemetry-ingestor");
  try {
    await setTimeout(1500);
    const request = await post(missing.id, randomUUID());
    assert.equal(request.status, 202);
    kill();
    await restart();
    await until(() => {
      const text = compose(
        "exec",
        "-T",
        "ros-bridge",
        "python3",
        "-c",
        `import os,sqlite3; d=sqlite3.connect(os.environ['BRIDGE_STATE_DIR']+'/bridge.sqlite3'); print(d.execute('SELECT response_event FROM cancel_requests LIMIT 1').fetchone())`,
      );
      return text.includes("UNKNOWN_GOAL");
    }, "actual unknown goal cancel response");
    evidence.push({
      case: "actual-unknown-goal-response",
      commandId: missing.id,
      cancelId: request.body.cancelId,
    });
  } finally {
    compose("unpause", "telemetry-ingestor");
  }
  await execution(missing.id, ["SUCCEEDED"]);
}
