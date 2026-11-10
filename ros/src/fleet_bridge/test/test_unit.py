import json
from pathlib import Path
import sqlite3
import time
from types import SimpleNamespace

import fastjsonschema
import pytest

from fleet_bridge.config import ConfigurationError, load_config
from fleet_bridge.cli import receive_pending
from fleet_bridge.journal import Journal, JournalError
from fleet_bridge.transport import MqttTransport, status_validator


def settings(tmp_path, **extra):
    return load_config({"BRIDGE_DEVICE_ID": "bridge-test", "BRIDGE_STATE_DIR": str(tmp_path),
                        **extra})


def test_udp_profile_exception_requires_explicit_test_mode(tmp_path):
    env = {"ROS_AUTOMATIC_DISCOVERY_RANGE": "SYSTEM_DEFAULT",
           "FASTRTPS_DEFAULT_PROFILES_FILE": "/workspace/config/dds-udp-test.xml"}
    with pytest.raises(ConfigurationError, match="ROS_DISCOVERY"):
        settings(tmp_path, **env)
    settings(tmp_path, **env, BRIDGE_INTEGRATION="true")
    with pytest.raises(ConfigurationError, match="ROS_DISCOVERY"):
        settings(tmp_path, **{**env, "FASTRTPS_DEFAULT_PROFILES_FILE": "/tmp/other.xml"},
                 BRIDGE_INTEGRATION="true")


def test_shared_wire_contract():
    validate = status_validator()
    fixtures = json.loads(Path("/workspace/contracts/status-fixtures.json").read_text())
    for case in fixtures:
        if case["valid"]:
            validate(case["message"])
        else:
            with pytest.raises(fastjsonschema.JsonSchemaException):
                validate(case["message"])


@pytest.mark.parametrize("name,value", [
    ("BRIDGE_DEVICE_ID", "secret/device"), ("BRIDGE_ROS_NAMESPACE", "/secret/namespace"),
    ("MQTT_HOST", "mqtt://secret:password@host"), ("MQTT_PORT", "0"),
    ("MQTT_PORT", "65536"), ("BRIDGE_QUEUE_LIMIT", "101"),
    ("BRIDGE_QUEUE_LIMIT", "0"), ("BRIDGE_RECONNECT_MAX_SEC", "9"),
    ("BRIDGE_BYTE_LIMIT", "33554433"), ("BRIDGE_RECORD_LIMIT", "10001"),
    ("ROS_DOMAIN_ID", "102"), ("ROS_STATIC_PEERS", "secret-host"),
    ("ROS_AUTOMATIC_DISCOVERY_RANGE", "SUBNET"), ("BRIDGE_STATE_DIR", "relative-secret"),
    ("MQTT_TRANSPORT", "unsupported-secret"),
])
def test_invalid_configuration_is_redacted(tmp_path, name, value):
    with pytest.raises(ConfigurationError) as error:
        settings(tmp_path, **{name: value})
    assert value not in str(error.value)


def test_tls_credentials_fail_closed(tmp_path):
    with pytest.raises(ConfigurationError, match="AWS_IOT_CREDENTIALS"):
        settings(tmp_path, MQTT_TRANSPORT="aws-iot", AWS_IOT_ENDPOINT="mqtt-tls",
                 AWS_IOT_ROOT_CA_PATH="/secret-missing", AWS_IOT_DEVICE_CREDENTIALS_DIR="/secret")


def test_owner_and_pending_records_survive_restart(tmp_path):
    config = settings(tmp_path)
    journal = Journal(config)
    try:
        with pytest.raises(JournalError):
            Journal(config)
        journal.receive("commands", b"payload")
        journal.receive("commands", b"payload")
        journal.status({"pending": True})
        assert journal.db.execute("SELECT count(*) FROM inbox").fetchone()[0] == 1
    finally:
        journal.close()
    journal = Journal(config)
    assert json.loads(journal.pending_status()) == {"pending": True}
    assert journal.db.execute("SELECT body FROM inbox").fetchone()[0] == b"payload"
    journal.close()
    with pytest.raises(JournalError):
        Journal(load_config({"BRIDGE_DEVICE_ID": "other", "BRIDGE_STATE_DIR": str(tmp_path)}))


def test_corrupt_or_unknown_journal_is_not_reset(tmp_path):
    path = tmp_path / "bridge.sqlite3"
    path.write_bytes(b"damaged-existing-journal")
    with pytest.raises(JournalError):
        Journal(settings(tmp_path))
    assert path.read_bytes() == b"damaged-existing-journal"
    path.unlink()
    sqlite3.connect(path).close()
    with pytest.raises(JournalError):
        Journal(settings(tmp_path))


def test_capacity_preserves_previous_records(tmp_path):
    journal = Journal(settings(tmp_path, BRIDGE_RECORD_LIMIT="1"))
    journal.receive("commands", b"first")
    with pytest.raises(JournalError, match="JOURNAL_FULL"):
        journal.receive("commands", b"second")
    assert journal.db.execute("SELECT body FROM inbox").fetchall() == [(b"first",)]
    journal.close()


def test_callback_queue_is_bounded_and_never_acknowledges(tmp_path):
    transport = MqttTransport(settings(tmp_path, BRIDGE_QUEUE_LIMIT="1"))
    calls = []
    client = SimpleNamespace(disconnect=lambda: calls.append("disconnect"))
    message = SimpleNamespace(topic=transport.topics[0], qos=1, mid=1, payload=b"first")
    transport.on_message(client, None, message)
    message.payload = b"overflow"
    transport.on_message(client, None, message)
    assert transport.inbox.qsize() == 1
    assert calls == ["disconnect"]
    assert transport.snapshot()["mqtt_last_failure"] == "MQTT_QUEUE_FULL"
    transport.stop_intake()
    transport.on_message(client, None, message)
    assert transport.inbox.qsize() == 1


def test_puback_is_scoped_to_connection_epoch(tmp_path):
    transport = MqttTransport(settings(tmp_path))
    calls = []
    transport.client.ack = lambda mid, qos: calls.append((mid, qos))
    transport.connected, transport.epoch = True, 2
    transport.acknowledge((1, 7, 1))
    assert not calls
    transport.acknowledge((2, 7, 1))
    assert calls == [(7, 1)]


def test_retained_commands_are_rejected_before_intake(tmp_path):
    transport = MqttTransport(settings(tmp_path))
    calls = []
    client = SimpleNamespace(disconnect=lambda: calls.append("disconnect"))
    transport.on_message(client, None, SimpleNamespace(
        topic=transport.topics[0], qos=1, mid=1, payload=b"{}", retain=True))
    assert transport.inbox.empty()
    assert calls == ["disconnect"]
    assert transport.snapshot()["mqtt_last_failure"] == "MQTT_PACKET_REJECTED"


def test_connection_is_not_subscription_readiness(tmp_path):
    transport = MqttTransport(settings(tmp_path))
    calls = []
    client = SimpleNamespace(subscribe=lambda _: (0, 1),
                             disconnect=lambda: calls.append("disconnect"))
    transport.on_connect(client, None, None, SimpleNamespace(is_failure=False), None)
    assert transport.snapshot()["mqtt_connected"]
    assert not transport.snapshot()["mqtt_subscribed"]
    transport.on_subscribe(client, None, 1, [SimpleNamespace(value=128)], None)
    assert not transport.snapshot()["mqtt_subscribed"]
    assert transport.snapshot()["mqtt_last_failure"] == "MQTT_SUBSCRIPTION_REJECTED"
    assert calls == ["disconnect"]


def test_stopped_intake_drains_queue_and_acknowledges_only_committed_records(tmp_path):
    config = settings(tmp_path)
    journal = Journal(config)
    transport = MqttTransport(config)
    transport.connected, transport.epoch = True, 1
    acknowledgements = []

    def acknowledge(mid, _qos):
        with sqlite3.connect(tmp_path / "bridge.sqlite3") as observer:
            assert observer.execute("SELECT body FROM inbox WHERE body=?",
                                    (str(mid).encode(),)).fetchone()
        acknowledgements.append(mid)

    transport.client.ack = acknowledge
    for mid in range(1, 4):
        transport.inbox.put_nowait((1, mid, 1, transport.topics[0], str(mid).encode()))
    transport.stop_intake()
    receive_pending(transport, journal)
    assert transport.inbox.empty() and acknowledgements == [1, 2, 3]
    journal.close()


def test_failed_commit_never_acknowledges(tmp_path):
    config = settings(tmp_path, BRIDGE_RECORD_LIMIT="1")
    journal = Journal(config)
    journal.receive("commands", b"existing")
    transport = MqttTransport(config)
    transport.connected, transport.epoch = True, 1
    transport.inbox.put_nowait((1, 3, 1, transport.topics[0], b"unsaved"))
    acknowledgements = []
    transport.client.ack = lambda *_: acknowledgements.append(True)
    with pytest.raises(JournalError):
        receive_pending(transport, journal)
    assert not acknowledgements
    journal.close()


def test_shutdown_drain_deadline_keeps_unacknowledged_queue(tmp_path):
    config = settings(tmp_path)
    journal = Journal(config)
    transport = MqttTransport(config)
    transport.inbox.put_nowait((1, 1, 1, transport.topics[0], b"pending"))
    transport.stop_intake()
    receive_pending(transport, journal, deadline=time.monotonic() - 1)
    assert transport.inbox.qsize() == 1
    assert journal.db.execute("SELECT count(*) FROM inbox").fetchone()[0] == 0
    journal.close()
