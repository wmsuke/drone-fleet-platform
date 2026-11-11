"""永続化/検証境界の単体試験。実Action・SIGKILLはCompose E2Eで別に確認する。"""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import uuid
from concurrent.futures import Future
from unittest.mock import Mock

import fastjsonschema
from builtin_interfaces.msg import Time
from fleet_bridge_interfaces.action import ReturnHome
import pytest
from rclpy.serialization import serialize_message
from unique_identifier_msgs.msg import UUID

from fleet_bridge.command_journal import CommandJournal
from fleet_bridge.config import load_config
from fleet_bridge.execution import Execution
from fleet_bridge.journal import Journal, JournalError
from fleet_reference.configuration import digest


def utc(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fixture(tmp_path, limit="10000"):
    configuration = json.loads(Path(
        "/workspace/contracts/configuration-fixtures.json").read_text())[0]["message"][
            "configuration"]
    now = datetime.now(timezone.utc)
    command = {"schemaVersion": 3, "deviceId": configuration["deviceId"],
               "commandId": str(uuid.uuid4()), "type": "RETURN_HOME", "targetKind": "ROS2",
               "expectedConfigurationId": digest(configuration),
               "timestamp": utc(now - timedelta(seconds=2)),
               "expiresAt": utc(now + timedelta(seconds=28)),
               "resultDeadline": utc(now + timedelta(seconds=118))}
    config = load_config({"BRIDGE_DEVICE_ID": command["deviceId"],
                          "BRIDGE_STATE_DIR": str(tmp_path), "BRIDGE_RECORD_LIMIT": limit})
    journal = Journal(config)
    commands = CommandJournal(journal)
    value = commands.prepare(command, configuration, now.timestamp())
    commands.send_intent(command["commandId"], now.timestamp())
    ros = SimpleNamespace(abandon_query=lambda _: None)
    execution = Execution(commands, ros)
    return journal, commands, execution, value, now


def result(value, now):
    ns = round(now.timestamp() * 1_000_000_000)
    stamp = Time(sec=ns // 1_000_000_000, nanosec=ns % 1_000_000_000)
    response = ReturnHome.Result()
    response.goal_id = UUID(uuid=list(uuid.UUID(value["goalId"]).bytes))
    response.server_instance_id = value["configuration"]["serverInstanceId"]
    response.configuration_id = value["configuration"]["adapterConfigurationId"]
    response.started = True
    response.started_at = Time(sec=stamp.sec - 1, nanosec=stamp.nanosec)
    response.finished_at = stamp
    response.reason = "HOME_REACHED"
    response.final_pose.header.frame_id = value["configuration"]["namespace"][1:] + "/map"
    response.final_pose.header.stamp = stamp
    response.final_velocity.header = response.final_pose.header
    response.home_distance_m = 0.1
    response.stable_duration_s = 1.2
    return response


def test_shared_action_fixtures():
    validate = fastjsonschema.compile(json.loads(Path(
        "/workspace/contracts/bridge-event.schema.json").read_text()), use_default=False)
    cases = json.loads(Path("/workspace/contracts/action-fixtures.json").read_text())
    for case in cases:
        if case["valid"]:
            validate(case["message"])
        else:
            with pytest.raises(fastjsonschema.JsonSchemaException):
                validate(case["message"])


def test_result_replay_keeps_original_event_and_hash_after_receipt(tmp_path):
    journal, commands, execution, value, now = fixture(tmp_path)
    command_id = value["commandId"]
    assert commands.receive(json.dumps(value["command"]), now.timestamp())
    response = result(value, now)
    execution.process_result(value, SimpleNamespace(status=4, result=response))
    original = journal.pending_bridge_events()[0][1]
    message = json.loads(original)
    assert message["status"] == "SUCCEEDED"
    assert message["result"]["hash"] == hashlib.sha256(serialize_message(response)).hexdigest()
    assert not commands.progress(command_id)["stopConfirmed"]
    journal.receive(f"fleet/v1/devices/{value['command']['deviceId']}/bridge-receipts", json.dumps({
        "schemaVersion": 1, "deviceId": value["command"]["deviceId"], "eventId": message["eventId"],
        "payloadHash": digest(message), "status": "STORED", "timestamp": message["timestamp"]}))
    assert journal.pending_bridge_events() == []
    assert commands.receive(json.dumps(value["command"]), now.timestamp() + 300)
    assert journal.pending_bridge_events()[0][1] == original
    assert commands.get(command_id)["goalId"] == value["goalId"]
    journal.close()


def test_invalid_result_preserves_raw_hash_as_uncertain_not_success(tmp_path):
    journal, commands, execution, value, now = fixture(tmp_path)
    response = result(value, now)
    response.goal_id = UUID(uuid=list(uuid.uuid4().bytes))
    execution.process_result(value, SimpleNamespace(status=4, result=response))
    message = json.loads(journal.pending_bridge_events()[0][1])
    assert message["status"] == "UNCERTAIN" and message["reason"] == "RESULT_INVALID"
    assert message["rawResult"]["hash"] == hashlib.sha256(serialize_message(response)).hexdigest()
    assert "startedAt" not in message
    assert not commands.progress(value["commandId"])["stopConfirmed"]
    journal.close()


def test_requery_budget_is_not_reset_by_process_reopen(tmp_path):
    journal, commands, _, value, now = fixture(tmp_path)
    config = journal.config
    for _ in range(5):
        commands.query_attempt(value["commandId"], now.timestamp())
    journal.close()
    journal = Journal(config)
    commands = CommandJournal(journal)
    execution = Execution(commands, SimpleNamespace(abandon_query=lambda _: None))
    assert commands.progress(value["commandId"])["queryCount"] == 5
    execution.reconcile(commands.get(value["commandId"]), None)
    assert commands.get(value["commandId"])["reason"] == "RESULT_TIMEOUT"
    assert not commands.progress(value["commandId"])["stopConfirmed"]
    journal.close()


def test_critical_capacity_failure_rolls_back_state_and_event(tmp_path):
    journal, commands, _, value, _ = fixture(tmp_path, "2")
    commands.event(value["commandId"], "GOAL_ACCEPTED", {"reason": "GOAL_ACCEPTED"}, "ACCEPTED")
    before = journal.pending_bridge_events()
    with pytest.raises(JournalError, match="JOURNAL_FULL"):
        commands.event(value["commandId"], "EXECUTION", {
            "status": "UNCERTAIN", "reason": "RESULT_TIMEOUT"}, "UNCERTAIN")
    assert commands.get(value["commandId"])["state"] == "ACCEPTED"
    assert journal.pending_bridge_events() == before
    journal.close()


def test_recovery_does_not_query_an_unconfirmed_server(tmp_path):
    journal, commands, execution, value, _ = fixture(tmp_path)
    execution.ros.query = Mock()
    execution.reconcile(value, None)
    assert commands.progress(value["commandId"])["queryCount"] == 0
    execution.ros.query.assert_not_called()
    execution.reconcile(value, SimpleNamespace(server_instance_id=str(uuid.uuid4())))
    assert commands.get(value["commandId"])["reason"] == "SERVER_CHANGED"
    execution.ros.query.assert_not_called()
    journal.close()


def test_normal_result_wait_unknown_reconciles_instead_of_invalid_result(tmp_path):
    journal, commands, execution, value, _ = fixture(tmp_path)
    execution.consume_result(value, SimpleNamespace(status=0))
    assert commands.get(value["commandId"])["state"] == "UNCERTAIN"
    assert commands.progress(value["commandId"])["terminalEvent"] is None
    execution.reconcile(commands.get(value["commandId"]),
                        SimpleNamespace(server_instance_id=str(uuid.uuid4())))
    assert commands.get(value["commandId"])["reason"] == "SERVER_CHANGED"
    assert not commands.progress(value["commandId"])["stopConfirmed"]
    journal.close()


@pytest.mark.parametrize("changed", [False, True])
def test_unknown_result_requires_a_new_generation_probe(tmp_path, changed):
    journal, commands, execution, value, now = fixture(tmp_path)
    serial = [1]
    execution.ros.runtime_probe_serial = lambda: serial[0]
    commands.query_attempt(value["commandId"], now.timestamp())
    future = Future()
    future.set_result(SimpleNamespace(status=0))
    execution.queries[value["commandId"]] = (future, 0)
    runtime = SimpleNamespace(server_instance_id=value["configuration"]["serverInstanceId"],
                              configuration_id=value["configuration"]["adapterConfigurationId"])
    execution.reconcile(value, runtime)
    assert commands.progress(value["commandId"])["terminalEvent"] is None
    serial[0] += 1
    if changed:
        runtime.server_instance_id = str(uuid.uuid4())
    execution.reconcile(value, runtime)
    assert commands.get(value["commandId"])["reason"] == (
        "SERVER_CHANGED" if changed else "RESULT_UNKNOWN")
    assert commands.progress(value["commandId"])["queryCount"] == 1
    assert not commands.progress(value["commandId"])["stopConfirmed"]
    journal.close()
