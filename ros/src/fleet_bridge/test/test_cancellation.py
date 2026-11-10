"""中断の永続性・状態境界の単体試験。実DDSはCompose E2Eで別に検証する。"""

from concurrent.futures import Future
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import uuid

from action_msgs.msg import GoalInfo
from action_msgs.srv import CancelGoal
import fastjsonschema
import pytest
from unique_identifier_msgs.msg import UUID
from rclpy.serialization import deserialize_message

from fleet_bridge.cancellation import Cancellation
from fleet_bridge.command_journal import CommandJournal, instant
from fleet_bridge.config import load_config
from fleet_bridge.journal import Journal, JournalError
from fleet_reference.configuration import digest


def fixture(tmp_path):
    snapshot = json.loads(Path("/workspace/contracts/configuration-fixtures.json").read_text())[
        0]["message"]["configuration"]
    now = datetime.now(timezone.utc)

    def stamp(seconds):
        return (now + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z")

    command = {"schemaVersion": 3, "deviceId": snapshot["deviceId"],
               "commandId": str(uuid.uuid4()), "type": "RETURN_HOME", "targetKind": "ROS2",
               "expectedConfigurationId": digest(snapshot), "timestamp": stamp(-1),
               "expiresAt": stamp(29), "resultDeadline": stamp(119)}
    journal = Journal(load_config({"BRIDGE_DEVICE_ID": snapshot["deviceId"],
                                   "BRIDGE_STATE_DIR": str(tmp_path)}))
    commands = CommandJournal(journal)
    value = commands.prepare(command, snapshot, now.timestamp())
    commands.send_intent(command["commandId"], now.timestamp())
    commands.event(command["commandId"], "GOAL_ACCEPTED", {"reason": "GOAL_ACCEPTED"}, "ACCEPTED")
    cancel_id = str(uuid.uuid4())
    request = {"schemaVersion": 1, "kind": "CANCEL_COMMAND", "deviceId": snapshot["deviceId"],
               "requestId": cancel_id, "cancelId": cancel_id, "commandId": command["commandId"],
               "goalId": value["goalId"], "configurationId": digest(snapshot),
               "serverInstanceId": snapshot["serverInstanceId"], "reason": "OPERATOR_REQUEST",
               "timestamp": stamp(0), "expiresAt": stamp(10)}
    calls, futures = [], []

    def send(goal):
        calls.append(goal)
        future = Future()
        futures.append(future)
        return future

    runtime = SimpleNamespace(server_instance_id=snapshot["serverInstanceId"],
                              configuration_id=snapshot["adapterConfigurationId"])
    ros = SimpleNamespace(cancel=send, runtime_snapshot=lambda: runtime,
                          abandon_cancel=lambda future: future.cancel())
    execution = SimpleNamespace(begin_recovery=lambda _: None)
    cancel = Cancellation(commands, ros, execution)
    assert cancel.receive(json.dumps(request), now.timestamp())
    return journal, commands, cancel, request, calls, futures, now.timestamp()


def response(request, code=0):
    result = CancelGoal.Response()
    result.return_code = code
    if code == 0:
        info = GoalInfo()
        info.goal_id = UUID(uuid=list(uuid.UUID(request["goalId"]).bytes))
        result.goals_canceling = [info]
    return result


def test_shared_cancel_fixtures():
    validate = fastjsonschema.compile(json.loads(Path(
        "/workspace/contracts/bridge-cancel.schema.json").read_text()), use_default=False)
    for fixture in json.loads(Path("/workspace/contracts/cancel-fixtures.json").read_text()):
        value = fixture["message"]
        try:
            validate(value)
            valid = (value["requestId"] == value["cancelId"]
                     and instant(value["expiresAt"]) == instant(value["timestamp"]) + 10)
        except fastjsonschema.JsonSchemaException:
            valid = False
        assert valid == fixture["valid"]


def test_accepted_is_not_terminal_or_stop_and_duplicates_do_not_send_again(tmp_path):
    journal, commands, cancel, request, calls, futures, now = fixture(tmp_path)
    cancel.tick()
    futures[0].set_result(response(request))
    cancel.tick()
    assert cancel.get(request["cancelId"])["state"] == "ACCEPTED"
    assert commands.get(request["commandId"])["state"] == "ACCEPTED"
    assert commands.progress(request["commandId"])["terminalEvent"] is None
    assert not commands.progress(request["commandId"])["stopConfirmed"]
    saved = cancel.get(request["cancelId"])["response"]
    assert cancel.receive(json.dumps(request), now + 20)
    assert not cancel.receive(json.dumps({**request, "reason": "DIFFERENT_REASON"}), now)
    cancel.tick()
    assert calls == [request["goalId"]]
    assert cancel.get(request["cancelId"])["response"] == saved
    journal.close()


def test_restart_does_not_reset_attempt_or_reissue_unknown_cancel(tmp_path):
    journal, commands, cancel, request, calls, _, _ = fixture(tmp_path)
    cancel.tick()
    cancel.close()
    cancel = Cancellation(commands, cancel.ros, cancel.execution)
    cancel.tick()
    assert cancel.get(request["cancelId"])["attempts"] == 1
    assert cancel.get(request["cancelId"])["state"] == "UNCERTAIN"
    assert calls == [request["goalId"]]
    journal.close()


def test_late_response_preserves_timeout_and_never_changes_execution(tmp_path, monkeypatch):
    journal, commands, cancel, request, calls, futures, now = fixture(tmp_path)
    cancel.tick()
    monkeypatch.setattr("fleet_bridge.cancellation.time.time", lambda: now + 11)
    cancel.tick()
    futures[0].set_result(response(request))
    cancel.tick()
    assert cancel.get(request["cancelId"])["state"] == "UNCERTAIN"
    assert json.loads(cancel.get(request["cancelId"])["response"])["phase"] == "ACCEPTED"
    assert commands.progress(request["commandId"])["terminalEvent"] is None
    assert len(calls) == 1
    journal.close()


@pytest.mark.parametrize("code", [0, 1])
def test_rejection_retains_ros_code_and_does_not_manufacture_stop(tmp_path, code):
    journal, commands, cancel, request, _, futures, _ = fixture(tmp_path)
    cancel.tick()
    rejected = response(request, code)
    rejected.goals_canceling = []
    futures[0].set_result(rejected)
    cancel.tick()
    event = json.loads(cancel.get(request["cancelId"])["response"])
    assert event["phase"] == "REJECTED" and event["response"]["returnCode"] == code
    assert not commands.progress(request["commandId"])["stopConfirmed"]
    journal.close()


def test_critical_capacity_failure_does_not_drop_existing_records(tmp_path):
    journal, _, cancel, request, _, _, _ = fixture(tmp_path)
    previous = journal.pending_bridge_events()
    object.__setattr__(journal.config, "record_limit", 1)
    with pytest.raises(JournalError):
        cancel.event(request["cancelId"], "UNCERTAIN", "RESPONSE_TIMEOUT")
    assert journal.pending_bridge_events() == previous
    journal.close()


def test_invalid_response_keeps_raw_hash_without_inventing_acceptance(tmp_path):
    journal, _, cancel, request, _, futures, _ = fixture(tmp_path)
    cancel.tick()
    invalid = response({**request, "goalId": str(uuid.uuid4())})
    futures[0].set_result(invalid)
    cancel.tick()
    value = cancel.get(request["cancelId"])
    event = json.loads(value["last"])
    assert value["state"] == "UNCERTAIN" and event["reason"] == "RESULT_INVALID"
    # CDRのpaddingは再serialize時に同一byteとは限らない。保存原文のhashと内容を照合する。
    raw = base64.b64decode(event["rawResponse"]["cdr"])
    assert event["rawResponse"]["hash"] == hashlib.sha256(raw).hexdigest()
    assert event["rawResponse"]["bytes"] == len(raw)
    assert deserialize_message(raw, CancelGoal.Response) == invalid
    journal.close()


def test_no_response_retries_only_same_goal_three_times(tmp_path, monkeypatch):
    journal, commands, cancel, request, calls, _, now = fixture(tmp_path)
    for offset in (0, 2.1, 4.2, 6.3, 8.4, 10.5):
        monkeypatch.setattr("fleet_bridge.cancellation.time.time", lambda: now + offset)
        cancel.tick()
    assert calls == [request["goalId"]] * 3
    assert cancel.get(request["cancelId"])["state"] == "UNCERTAIN"
    assert not commands.progress(request["commandId"])["stopConfirmed"]
    cancel.close()
    cancel = Cancellation(commands, cancel.ros, cancel.execution)
    cancel.tick()
    assert cancel.get(request["cancelId"])["attempts"] == 3
    assert len(calls) == 3
    journal.close()
