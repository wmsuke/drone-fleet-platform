"""healthは実行終端/停止と別の永続eventで、DB receiptまで残す。"""

import json
from pathlib import Path
from types import SimpleNamespace

import fastjsonschema
import pytest

from fleet_bridge.config import load_config
from fleet_bridge.health import Health
from fleet_bridge.journal import Journal, JournalError


def test_shared_health_contract():
    validate = fastjsonschema.compile(json.loads(Path(
        "/workspace/contracts/bridge-event.schema.json").read_text()))
    for case in json.loads(Path("/workspace/contracts/health-fixtures.json").read_text()):
        if case["valid"]:
            validate(case["message"])
        else:
            with pytest.raises(fastjsonschema.JsonSchemaException):
                validate(case["message"])


def test_health_is_durable_receipted_and_not_a_stop(tmp_path):
    value = json.loads(Path("/workspace/contracts/configuration-fixtures.json").read_text())[0][
        "message"]["configuration"]
    config = load_config({"BRIDGE_DEVICE_ID": value["deviceId"],
                          "BRIDGE_STATE_DIR": str(tmp_path)})
    journal = Journal(config)
    journal.configuration_report(value)
    ros = SimpleNamespace(runtime_snapshot=lambda: None,
                          observations=SimpleNamespace(execution_sample=lambda: None))
    commands = SimpleNamespace(open_commands=lambda: [])
    health = Health(journal, commands, ros)
    mqtt = {"mqtt_connected": True, "mqtt_subscribed": True}
    health.tick(mqtt, False)
    events = journal.pending_bridge_events()
    event = json.loads(events[-1][1])
    assert event["kind"] == "ROS_HEALTH" and event["reason"] == "ROS_UNAVAILABLE"
    assert "commandId" not in event and "stopConfirmed" not in event
    health.tick(mqtt, False)
    assert journal.pending_bridge_events() == events  # 同状態の無制限連続保存をしない。
    journal.close()
    journal = Journal(config)
    assert journal.pending_bridge_events() == events
    health = Health(journal, commands, ros)
    object.__setattr__(config, "record_limit", 1)
    with pytest.raises(JournalError):
        health.tick(mqtt, False)
    assert journal.pending_bridge_events() == events
    journal.close()
