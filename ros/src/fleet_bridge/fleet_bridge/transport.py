"""MQTT callbackは状態更新とbounded queue投入だけを行う。"""

from datetime import datetime, timezone
import json
from pathlib import Path
import queue
import ssl
import threading

import fastjsonschema
import paho.mqtt.client as mqtt


def status_message(device, status, reason):
    return {"schemaVersion": 1, "deviceId": device,
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"), "payload": {"status": status, "reason": reason}}


def status_validator():
    path = Path("/workspace/contracts/connection-status.schema.json")
    return fastjsonschema.compile(json.loads(path.read_text()), use_default=False)


class MqttTransport:
    def __init__(self, config):
        self.config = config
        self.inbox = queue.Queue(config.queue_limit)
        self.guard = threading.Lock()
        self.connected = False
        self.subscribed = False
        self.accepting = True
        self.reason = "MQTT_CONNECTING"
        self.last_failure = None
        self.epoch = 0
        self.stop = threading.Event()
        self.thread = None
        self.prefix = f"fleet/v1/devices/{config.device_id}/"
        self.topics = [self.prefix + "commands", self.prefix + "telemetry-receipts",
                       self.prefix + "bridge-receipts"]
        self.validate = status_validator()
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id=config.client_id,
            clean_session=False, protocol=mqtt.MQTTv311, manual_ack=True,
            reconnect_on_failure=False,
        )
        self.client.connect_timeout = 2
        self.client.max_inflight_messages_set(1)
        self.client.max_queued_messages_set(config.queue_limit)
        if config.tls:
            self.client.tls_set_context(config.tls)
        will = status_message(config.device_id, "OFFLINE", "CONNECTION_LOST")
        self.validate(will)
        self.client.will_set(self.prefix + "status", json.dumps(will), qos=1, retain=False)
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_subscribe = self.on_subscribe
        self.client.on_message = self.on_message

    def snapshot(self):
        with self.guard:
            return {"mqtt_connected": self.connected, "mqtt_subscribed": self.subscribed,
                    "mqtt_reason": self.reason, "mqtt_epoch": self.epoch,
                    "mqtt_last_failure": self.last_failure}

    def on_connect(self, client, _data, _flags, reason, _properties):
        with self.guard:
            self.epoch += 1
            self.connected = not reason.is_failure
            self.subscribed = False
            self.reason = "MQTT_SUBSCRIBING" if self.connected else "MQTT_REJECTED"
            if reason.is_failure:
                self.last_failure = "MQTT_REJECTED"
        if not reason.is_failure:
            result, _mid = client.subscribe([(topic, 1) for topic in self.topics])
            if result != mqtt.MQTT_ERR_SUCCESS:
                client.disconnect()

    def on_subscribe(self, client, _data, _mid, reasons, _properties):
        valid = len(reasons) == len(self.topics) and all(reason.value == 1 for reason in reasons)
        with self.guard:
            self.subscribed = valid
            self.reason = "MQTT_READY" if valid else "MQTT_SUBSCRIPTION_REJECTED"
            self.last_failure = None if valid else "MQTT_SUBSCRIPTION_REJECTED"
        if not valid:
            client.disconnect()

    def on_disconnect(self, _client, _data, _flags, _reason, _properties):
        with self.guard:
            self.connected = self.subscribed = False
            self.epoch += 1
            self.reason = "MQTT_DISCONNECTED"

    def on_message(self, client, _data, message):
        with self.guard:
            if not self.accepting:
                return
            epoch = self.epoch
        if (message.topic not in self.topics or message.qos != 1
                or len(message.payload) > 32768):
            # 受領ACKを返さず接続を閉じる。本文・topic・例外をログへ出さない。
            with self.guard:
                self.last_failure = "MQTT_PACKET_REJECTED"
            client.disconnect()
            return
        try:
            self.inbox.put_nowait((epoch, message.mid, message.qos, message.topic, message.payload))
        except queue.Full:
            with self.guard:
                self.last_failure = "MQTT_QUEUE_FULL"
            client.disconnect()

    def acknowledge(self, item):
        with self.guard:
            if self.connected and self.epoch == item[0]:
                self.client.ack(item[1], item[2])

    def start(self):
        self.thread = threading.Thread(target=self.run, name="bridge-mqtt")
        self.thread.start()

    def run(self):
        delay = self.config.reconnect_min
        while not self.stop.is_set():
            try:
                self.client.connect(self.config.host, self.config.port, keepalive=10)
                while not self.stop.is_set():
                    if self.client.loop(timeout=0.1) != mqtt.MQTT_ERR_SUCCESS:
                        break
                    if self.snapshot()["mqtt_subscribed"]:
                        delay = self.config.reconnect_min
            except Exception as error:
                with self.guard:
                    self.last_failure = ("MQTT_TLS_FAILED" if isinstance(error, ssl.SSLError)
                                         else "MQTT_CONNECTION_FAILED")
                # 認証/endpoint由来の例外文字列を漏らさない。
            with self.guard:
                self.connected = self.subscribed = False
                self.reason = "MQTT_DISCONNECTED"
                self.epoch += 1
            self.client.disconnect()
            if not self.stop.is_set():
                self.stop.wait(delay)
                delay = min(self.config.reconnect_max, delay * 2)

    def publish_status(self, body):
        self.validate(json.loads(body))
        info = self.client.publish(self.prefix + "status", body, qos=1, retain=False)
        return info if info.rc == mqtt.MQTT_ERR_SUCCESS else None

    def publish_observation(self, body):
        info = self.client.publish(self.prefix + "telemetry", body, qos=1, retain=False)
        return info if info.rc == mqtt.MQTT_ERR_SUCCESS else None

    def publish_bridge_event(self, body):
        info = self.client.publish(self.prefix + "bridge-events", body, qos=1, retain=False)
        return info if info.rc == mqtt.MQTT_ERR_SUCCESS else None

    def stop_intake(self):
        with self.guard:
            self.accepting = False

    def close(self):
        self.stop_intake()
        self.stop.set()
        self.client.disconnect()
        if self.thread:
            self.thread.join(timeout=4)
            if self.thread.is_alive():
                raise RuntimeError("MQTT_SHUTDOWN_TIMEOUT")
