import json
from pathlib import Path

import fastjsonschema
import pytest

from fleet_bridge.config import load_config
from fleet_bridge.journal import Journal, JournalError
from fleet_reference.configuration import canonical, digest


def cases():
    return json.loads(Path("/workspace/contracts/configuration-fixtures.json").read_text())


def test_shared_fixtures_and_canonical_identity():
    validate = fastjsonschema.compile(json.loads(Path(
        "/workspace/contracts/bridge-event.schema.json").read_text()))
    for case in cases():
        if case["valid"]:
            validate(case["message"])
        else:
            with pytest.raises(fastjsonschema.JsonSchemaException):
                validate(case["message"])
    value = cases()[0]["message"]
    assert digest(value["configuration"]) == value["configurationId"]
    with pytest.raises(ValueError):
        canonical({"value": 0.1})
    assert canonical({"z": 0, "a": [True, None, "value"]}) == (
        '{"a":[true,null,"value"],"z":0}')


def test_persistent_counters_and_receipt_not_puback(tmp_path):
    value = cases()[0]["message"]["configuration"]
    config = load_config({"BRIDGE_DEVICE_ID": value["deviceId"],
                          "BRIDGE_STATE_DIR": str(tmp_path)})
    journal = Journal(config)
    journal.configuration_report(value)
    body = journal.pending_bridge_events()[0][1]
    first = json.loads(body)
    assert first["configurationRevision"] == 1 and first["reportSequence"] == 1
    journal.close()
    journal = Journal(config)
    assert journal.pending_bridge_events()[0][1] == body
    journal.configuration_report(value)
    second = json.loads(journal.pending_bridge_events()[1][1])
    assert second["journalId"] == first["journalId"]
    assert second["sessionId"] != first["sessionId"]
    assert second["configurationRevision"] == 1 and second["reportSequence"] == 2
    updated = {**value, "adapterConfigurationId": "d" * 64}
    journal.configuration_report(updated)
    third = json.loads(journal.pending_bridge_events()[2][1])
    assert third["configurationRevision"] == 2 and third["reportSequence"] == 3
    receipt = {"schemaVersion": 1, "deviceId": config.device_id,
               "eventId": first["eventId"], "payloadHash": "f" * 64,
               "status": "STORED", "timestamp": first["timestamp"]}
    topic = f"fleet/v1/devices/{config.device_id}/bridge-receipts"
    journal.receive(topic, json.dumps(receipt).encode())
    assert len(journal.pending_bridge_events()) == 3
    receipt["payloadHash"] = digest(first)
    journal.receive(topic, json.dumps(receipt).encode())
    assert len(journal.pending_bridge_events()) == 2
    journal.close()


def test_critical_event_capacity_never_evicts(tmp_path):
    value = cases()[0]["message"]["configuration"]
    config = load_config({"BRIDGE_DEVICE_ID": value["deviceId"],
                          "BRIDGE_STATE_DIR": str(tmp_path), "BRIDGE_RECORD_LIMIT": "1"})
    journal = Journal(config)
    journal.configuration_report(value)
    first = journal.pending_bridge_events()
    with pytest.raises(JournalError, match="JOURNAL_FULL"):
        journal.configuration_report(value)
    assert journal.pending_bridge_events() == first
    assert journal.db.execute("SELECT sequence FROM bridge_counters").fetchone()[0] == 1
    journal.close()
