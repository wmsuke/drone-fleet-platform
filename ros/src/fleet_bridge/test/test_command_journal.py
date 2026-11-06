"""送信境界・再起動・重複本文をSQLiteの外部動作で検証する。"""

import copy
import json
import uuid
from pathlib import Path

import pytest

from fleet_bridge.command_journal import CommandJournal, instant
from fleet_bridge.config import load_config
from fleet_bridge.journal import Journal, JournalError
from fleet_reference.configuration import digest


def inputs():
    configuration = json.loads(Path(
        "/workspace/contracts/configuration-fixtures.json").read_text())[0]["message"][
            "configuration"]
    command = {"schemaVersion": 3, "deviceId": configuration["deviceId"],
               "commandId": str(uuid.uuid4()), "type": "RETURN_HOME", "targetKind": "ROS2",
               "expectedConfigurationId": digest(configuration),
               "timestamp": "2026-11-06T03:00:00.000Z",
               "expiresAt": "2026-11-06T03:00:30.000Z",
               "resultDeadline": "2026-11-06T03:02:00.000Z"}
    return configuration, command, instant(command["timestamp"]) + 1


def open_journal(tmp_path, device_id, **options):
    journal = Journal(load_config({"BRIDGE_DEVICE_ID": device_id,
                                   "BRIDGE_STATE_DIR": str(tmp_path), **options}))
    return journal, CommandJournal(journal)


@pytest.mark.parametrize("boundary", ["READY", "SEND_INTENT", "ACCEPTED"])
def test_restart_never_assigns_another_uuid(tmp_path, boundary):
    configuration, command, now = inputs()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    original = commands.prepare(command, configuration, now)
    if boundary != "READY":
        commands.send_intent(command["commandId"], now)
    if boundary == "ACCEPTED":
        commands.accepted(command["commandId"])
    journal.close()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    queries = commands.recovery()
    repeated = commands.prepare(command, configuration, now + 300)
    assert repeated["goalId"] == original["goalId"]
    assert repeated["configuration"] == original["configuration"]
    assert repeated["state"] == ("READY" if boundary == "READY" else "UNCERTAIN")
    assert len(queries) == (0 if boundary == "READY" else 1)
    if queries:
        with pytest.raises(JournalError, match="SEND_NOT_ALLOWED"):
            commands.send_intent(command["commandId"], now)
    journal.close()


def test_payload_conflict_and_unresolved_exclusion(tmp_path):
    configuration, command, now = inputs()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    original = commands.prepare(command, configuration, now)
    with pytest.raises(JournalError, match="COMMAND_CONFLICT"):
        commands.prepare({**command, "expectedConfigurationId": "f" * 64}, configuration, now)
    with pytest.raises(JournalError, match="GOAL_UNRESOLVED"):
        commands.prepare({**command, "commandId": str(uuid.uuid4())}, configuration, now)
    assert commands.get(command["commandId"]) == original
    journal.close()


@pytest.mark.parametrize("time_offset", [-6, 30, 120])
def test_cannot_prepare_outside_start_window(tmp_path, time_offset):
    configuration, command, now = inputs()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    with pytest.raises(JournalError, match="COMMAND_EXPIRED_OR_CLOCK_INVALID"):
        commands.prepare(command, configuration, now - 1 + time_offset)
    assert commands.get(command["commandId"]) is None
    journal.close()


def test_persistent_rejection_is_not_a_fake_execution_start(tmp_path):
    configuration, command, now = inputs()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    commands.prepare(command, configuration, now)
    commands.send_intent(command["commandId"], now)
    commands.rejected(command["commandId"])
    journal.close()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    assert commands.recovery() == []
    value = commands.prepare(command, configuration, now + 300)
    assert value["state"] == "REJECTED" and value["result"] is None
    assert "startedAt" not in value
    journal.close()


def test_capacity_is_shared_and_history_never_evicted(tmp_path):
    configuration, command, now = inputs()
    journal, commands = open_journal(tmp_path, command["deviceId"], BRIDGE_RECORD_LIMIT="1")
    original = commands.prepare(command, configuration, now)
    with pytest.raises(JournalError, match="JOURNAL_FULL"):
        journal.configuration_report(configuration)
    assert commands.get(command["commandId"]) == original
    journal.close()


def test_unknown_capability_and_configuration_mismatch(tmp_path):
    configuration, command, now = inputs()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    with pytest.raises(JournalError, match="CONFIGURATION_MISMATCH"):
        commands.prepare({**command, "expectedConfigurationId": "f" * 64}, configuration, now)
    unknown = copy.deepcopy(configuration)
    unknown["bridge"] = {"status": "UNKNOWN", "reason": "VERSION_UNREPORTED"}
    with pytest.raises(JournalError, match="CAPABILITY_UNKNOWN"):
        commands.prepare({**command, "expectedConfigurationId": digest(unknown)}, unknown, now)
    assert commands.get(command["commandId"]) is None
    journal.close()


@pytest.mark.parametrize("field", ["expiresAt", "resultDeadline"])
def test_python_enforces_deadline_correlation(tmp_path, field):
    configuration, command, now = inputs()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    changed = {**command, field: "2026-11-06T03:00:31.000Z"}
    with pytest.raises(JournalError, match="COMMAND_DEADLINE_INVALID"):
        commands.prepare(changed, configuration, now)
    assert commands.get(command["commandId"]) is None
    journal.close()


def test_send_intent_rechecks_deadline(tmp_path):
    configuration, command, now = inputs()
    journal, commands = open_journal(tmp_path, command["deviceId"])
    original = commands.prepare(command, configuration, now)
    with pytest.raises(JournalError, match="COMMAND_EXPIRED"):
        commands.send_intent(command["commandId"], instant(command["expiresAt"]))
    assert commands.get(command["commandId"]) == original
    journal.close()
