"""実Mosquittoと別processのROS/Bridgeでlifecycleを確認する。"""

import json
import os
import select
import socket
import socketserver
import ssl
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import paho.mqtt.client as mqtt
import pytest

from fleet_bridge.config import load_config


pytestmark = pytest.mark.skipif(os.getenv("BRIDGE_INTEGRATION") != "true",
                                reason="dedicated MQTT/ROS Compose required")


def until(predicate, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("bounded lifecycle wait expired")


def health(directory):
    try:
        return json.loads((directory / "health.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


@pytest.fixture
def processes(tmp_path):
    children = []

    def launch(module, args=(), env=None):
        log = (tmp_path / f"process-{len(children)}.log").open("w+")
        child_env = dict(os.environ)
        for key in list(child_env):
            if key.startswith(("AWS_IOT_", "MQTT_", "BRIDGE_")):
                del child_env[key]
        child_env.update(env or {})
        process = subprocess.Popen([sys.executable, "-m", module, *args], env=child_env,
                                   stdout=log, stderr=subprocess.STDOUT)
        children.append((process, log))
        return process

    yield launch
    errors = []
    for process, log in reversed(children):
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
            errors.append("forced shutdown")
        log.seek(0)
        text = log.read()
        print(text)
        if "Traceback" in text or "exception was never retrieved" in text:
            errors.append(text)
        log.close()
    assert not errors


class Proxy(socketserver.ThreadingTCPServer):
    """実brokerへのTCP経路だけを切断する障害注入。DDS経路は変更しない。"""

    allow_reuse_address = True

    def __init__(self):
        self.cut = threading.Event()
        self.connections = set()
        self.guard = threading.Lock()
        owner = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                upstream = None
                try:
                    if owner.cut.is_set():
                        return
                    upstream = socket.create_connection(("mqtt", 1883), timeout=2)
                    with owner.guard:
                        owner.connections.update((self.request, upstream))
                    while not owner.cut.is_set():
                        readable, _, _ = select.select([self.request, upstream], [], [], 0.1)
                        for source in readable:
                            data = source.recv(65536)
                            if not data:
                                return
                            (upstream if source is self.request else self.request).sendall(data)
                except OSError:
                    pass
                finally:
                    with owner.guard:
                        owner.connections.discard(self.request)
                        owner.connections.discard(upstream)
                    if upstream:
                        upstream.close()

        super().__init__(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.serve_forever)
        self.thread.start()

    def pause(self):
        self.cut.set()
        with self.guard:
            for connection in list(self.connections):
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def close(self):
        self.pause()
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=3)
        assert not self.thread.is_alive()


def start_reference(launch, tmp_path, device):
    path = tmp_path / f"{device}.json"
    path.write_text(json.dumps({"devices": [{"device_id": device}]}))
    return launch("fleet_reference.cli", ["--config", str(path)])


def start_bridge(launch, directory, device, **extra):
    return launch("fleet_bridge.cli", env={
        "BRIDGE_DEVICE_ID": device, "BRIDGE_STATE_DIR": str(directory),
        "MQTT_HOST": "mqtt", **extra,
    })


@pytest.fixture
def probe():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    messages = []
    subscribed = threading.Event()
    client.on_connect = lambda c, *_: c.subscribe("fleet/v1/devices/+/status", qos=1)
    client.on_subscribe = lambda *_: subscribed.set()
    client.on_message = lambda _c, _u, msg: messages.append(json.loads(msg.payload))
    client.connect("mqtt", 1883)
    client.loop_start()
    assert subscribed.wait(5)
    yield client, messages
    client.disconnect()
    client.loop_stop()


def test_separate_failures_reconnect_persistence_and_shutdown(processes, tmp_path, probe):
    launch = processes
    device = "bridge-life"
    directory = tmp_path / "state"
    reference = start_reference(launch, tmp_path, device)
    proxy = Proxy()
    client, messages = probe
    try:
        bridge = start_bridge(launch, directory, device, MQTT_HOST="127.0.0.1",
                              MQTT_PORT=str(proxy.server_address[1]))
        until(lambda: health(directory).get("mqtt_subscribed")
              and health(directory).get("ros_available"))
        assert health(directory)["ready"] is False
        assert health(directory)["accepting_operations"] is False
        until(lambda: any(m["deviceId"] == device and m["payload"]["status"] == "ONLINE"
                          for m in messages))
        payload = b'{"notYetACommand":true}'
        expected = [(payload,)]
        client.publish(f"fleet/v1/devices/{device}/commands", payload, qos=1).wait_for_publish(3)

        def saved():
            with sqlite3.connect(directory / "bridge.sqlite3") as db:
                return db.execute("SELECT body FROM inbox ORDER BY body").fetchall() == sorted(
                    expected,
                )

        until(saved)
        reference.terminate()
        assert reference.wait(timeout=8) == 0
        until(lambda: health(directory).get("ros_available") is False)
        assert health(directory)["mqtt_subscribed"]
        reference = start_reference(launch, tmp_path, device)
        until(lambda: health(directory).get("ros_available"))
        proxy.pause()
        until(lambda: health(directory).get("mqtt_connected") is False)
        assert health(directory)["ros_available"]
        queued = b'{"sentWhileDisconnected":true}'
        client.publish(f"fleet/v1/devices/{device}/commands", queued, qos=1).wait_for_publish(3)
        expected.append((queued,))
        proxy.cut.clear()
        until(lambda: health(directory).get("mqtt_subscribed")
              and health(directory).get("ros_available"))
        assert health(directory)["ros_available"]
        until(saved)
        bridge.terminate()
        assert bridge.wait(timeout=10) == 0
        assert health(directory)["stopping"]
        until(lambda: any(m["deviceId"] == device and m["payload"]["reason"] == "SHUTDOWN"
                          for m in messages))
        assert saved()
        # journal所有lockが解放され、同じ未実装commandを保持したまま再起動できる。
        bridge = start_bridge(launch, directory, device)
        until(lambda: health(directory).get("mqtt_subscribed")
              and not health(directory).get("stopping"))
        assert saved()
        bridge.terminate()
        assert bridge.wait(timeout=10) == 0
    finally:
        proxy.close()


def test_two_devices_do_not_mix_identity(processes, tmp_path, probe):
    launch = processes
    states = []
    for device in ("bridge-a", "bridge-b"):
        start_reference(launch, tmp_path, device)
        directory = tmp_path / device
        start_bridge(launch, directory, device)
        states.append((device, directory))
    until(lambda: all(health(path).get("ros_available") and health(path).get("mqtt_subscribed")
                      for _, path in states))
    probe[0].publish("fleet/v1/devices/bridge-a/commands", b"only-a", qos=1).wait_for_publish(3)

    def counts():
        result = []
        for _, path in states:
            with sqlite3.connect(path / "bridge.sqlite3") as db:
                result.append(db.execute("SELECT count(*) FROM inbox").fetchone()[0])
        return result

    until(lambda: counts() == [1, 0])
    assert [health(path)["device_id"] for _, path in states] == ["bridge-a", "bridge-b"]


def test_disconnected_shutdown_preserves_status_and_releases_lock(processes, tmp_path):
    directory = tmp_path / "offline"
    bridge = start_bridge(processes, directory, "bridge-offline", MQTT_HOST="127.0.0.1",
                          MQTT_PORT="1")
    until(lambda: bool(health(directory)))
    assert not health(directory)["mqtt_connected"]
    bridge.terminate()
    assert bridge.wait(timeout=10) == 0
    with sqlite3.connect(directory / "bridge.sqlite3") as db:
        body = db.execute("SELECT body FROM status_outbox").fetchone()[0]
        assert json.loads(body)["payload"]["reason"] == "SHUTDOWN"
    bridge = start_bridge(processes, directory, "bridge-offline", MQTT_HOST="127.0.0.1",
                          MQTT_PORT="1")
    until(lambda: bool(health(directory)) and not health(directory).get("stopping"))
    assert bridge.poll() is None
    bridge.terminate()
    assert bridge.wait(timeout=10) == 0


def test_invalid_startup_redacts_credentials_and_never_starts_ros(processes, tmp_path):
    process = start_bridge(processes, tmp_path / "invalid", "bridge-invalid",
                           MQTT_HOST="mqtt://secret-user:secret-password@secret-host")
    assert process.wait(timeout=5) == 2
    assert not (tmp_path / "invalid" / "bridge.sqlite3").exists()
    log = next(tmp_path.glob("process-*.log")).read_text()
    assert "secret-user" not in log and "secret-password" not in log
    assert "secret-host" not in log and "BRIDGE_CONFIGURATION_INVALID" in log


def test_mtls_uses_existing_device_file_layout(processes, tmp_path):
    directory = tmp_path / "tls"
    env = {
        "BRIDGE_DEVICE_ID": "bridge-tls", "BRIDGE_STATE_DIR": str(directory),
        "MQTT_TRANSPORT": "aws-iot", "AWS_IOT_ENDPOINT": "mqtt-tls",
        "AWS_IOT_ROOT_CA_PATH": "/test-certs/ca.crt",
        "AWS_IOT_DEVICE_CREDENTIALS_DIR": "/test-certs/devices",
    }
    context = load_config(env).tls
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
    assert context.minimum_version >= ssl.TLSVersion.TLSv1_2
    process = processes("fleet_bridge.cli", env=env)
    until(lambda: health(directory).get("mqtt_subscribed"))
    assert not health(directory)["ros_available"]
    assert not health(directory)["ready"]
    process.terminate()
    assert process.wait(timeout=10) == 0
    # 同じCA/証明書でも別hostnameを拒否し、検証無効化で回避しない。
    wrong = tmp_path / "wrong-hostname"
    process = processes("fleet_bridge.cli", env={
        **env, "BRIDGE_STATE_DIR": str(wrong), "AWS_IOT_ENDPOINT": "wrong-name",
    })
    until(lambda: health(wrong).get("mqtt_last_failure") == "MQTT_TLS_FAILED")
    assert not health(wrong)["mqtt_connected"]
    process.terminate()
    assert process.wait(timeout=10) == 0


def test_second_owner_fails_without_stopping_first(processes, tmp_path):
    directory = tmp_path / "owner"
    first = start_bridge(processes, directory, "bridge-owner", MQTT_HOST="127.0.0.1",
                         MQTT_PORT="1")
    until(lambda: bool(health(directory)))
    second = start_bridge(processes, directory, "bridge-owner", MQTT_HOST="127.0.0.1",
                          MQTT_PORT="1")
    assert second.wait(timeout=8) == 1
    assert first.poll() is None
    assert not health(directory)["stopping"]
    first.terminate()
    assert first.wait(timeout=10) == 0


def test_full_journal_fails_closed_without_deleting_records(processes, tmp_path):
    directory = tmp_path / "capacity"
    process = start_bridge(processes, directory, "bridge-capacity", MQTT_HOST="127.0.0.1",
                           MQTT_PORT="1", BRIDGE_RECORD_LIMIT="2")
    assert process.wait(timeout=15) == 1
    assert health(directory)["stopping"] and not health(directory)["ready"]
    with sqlite3.connect(directory / "bridge.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM lifecycle").fetchone()[0] == 2


def test_command_receipt_is_durable_before_mqtt_ack_and_sigkill_restart(processes, tmp_path):
    device = "bridge-receipt"
    directory = tmp_path / "receipt"
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    subscribed = threading.Event()
    messages = []
    committed = []
    client.on_connect = lambda c, *_: c.subscribe(f"fleet/v1/devices/{device}/command-acks", 1)
    client.on_subscribe = lambda *_: subscribed.set()

    def on_message(_client, _data, message):
        value = json.loads(message.payload)
        with sqlite3.connect(directory / "bridge.sqlite3") as db:
            stored = db.execute("SELECT ack FROM command_receipts WHERE command=?",
                                (value["commandId"],)).fetchone()
            committed.append(stored is not None and stored[0] == message.payload.decode())
        messages.append(value)

    client.on_message = on_message
    client.connect("mqtt", 1883)
    client.loop_start()
    try:
        assert subscribed.wait(5)
        bridge = start_bridge(processes, directory, device)
        until(lambda: health(directory).get("mqtt_subscribed"))
        now = datetime.now(timezone.utc)

        def utc(value):
            return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")

        command = {"schemaVersion": 3, "deviceId": device, "commandId": str(uuid.uuid4()),
                   "type": "RETURN_HOME", "targetKind": "ROS2",
                   "expectedConfigurationId": "a" * 64, "timestamp": utc(now),
                   "expiresAt": utc(now + timedelta(seconds=30)),
                   "resultDeadline": utc(now + timedelta(seconds=120))}
        topic = f"fleet/v1/devices/{device}/commands"
        client.publish(topic, json.dumps(command), qos=1).wait_for_publish(3)
        until(lambda: len(messages) == 1)
        original = messages[0]
        assert original["status"] == "ACKNOWLEDGED" and committed == [True]
        assert not health(directory)["ready"] and not health(directory)["ros_available"]
        bridge.kill()
        assert bridge.wait(timeout=5) == -9
        restarted = start_bridge(processes, directory, device)
        until(lambda: health(directory).get("mqtt_subscribed")
              and health(directory).get("mqtt_epoch") and restarted.poll() is None)
        client.publish(topic, json.dumps(command, sort_keys=True), qos=1).wait_for_publish(3)
        until(lambda: len(messages) >= 2)
        assert all(message == original for message in messages)
        assert all(committed)
        with sqlite3.connect(directory / "bridge.sqlite3") as db:
            assert db.execute("SELECT count(*) FROM command_receipts").fetchone()[0] == 1
            assert db.execute("SELECT count(*) FROM action_commands").fetchone()[0] == 0
        restarted.terminate()
        assert restarted.wait(timeout=10) == 0
    finally:
        client.disconnect()
        client.loop_stop()
