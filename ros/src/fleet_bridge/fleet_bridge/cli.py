"""起動・終了の所有者。callbackからSQLiteや同期ROS待ちを呼ばない。"""

import json
import os
import queue
import signal
import sys
import threading
import time

import rclpy

from .config import ConfigurationError, load_config
from .journal import Journal, JournalError
from .ros_client import RosClient
from .transport import MqttTransport, status_message


def health_file(config, state):
    path = config.state_dir / f".health-{os.getpid()}.tmp"
    descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(state, output)
    os.replace(path, config.state_dir / "health.json")


def receive_pending(transport, journal, deadline=None):
    for _ in range(transport.config.queue_limit):
        if deadline is not None and time.monotonic() >= deadline:
            break
        try:
            item = transport.inbox.get_nowait()
        except queue.Empty:
            break
        journal.receive(item[3], item[4])
        transport.acknowledge(item)  # SQLite commitより前にPUBACKしない


def run(config, stopping):
    journal = transport = ros = None
    last = None
    inflight = None
    telemetry_inflight = None
    telemetry_due = {}
    telemetry_epoch = None
    exit_code = 0
    try:
        journal = Journal(config)
        transport = MqttTransport(config)
        ros = RosClient(config)
        transport.start()
        while not stopping.is_set():
            state = {"device_id": config.device_id, **transport.snapshot(), **ros.snapshot(),
                     **ros.observations.health(),
                     "ready": False, "accepting_operations": False,
                     "operation_reason": "OPERATIONS_NOT_IMPLEMENTED", "stopping": False}
            if state != last:
                journal.record(state)
                health_file(config, state)
                # 接続状態のONLINEはROS availability/実行readyとは独立。
                if state["mqtt_subscribed"] and (not last or not last["mqtt_subscribed"]):
                    message = status_message(config.device_id, "ONLINE", "CONNECTED")
                    transport.validate(message)
                    journal.status(message)
                print(json.dumps({"event": "BRIDGE_STATE", **state}), flush=True)
                last = state
            receive_pending(transport, journal, deadline=time.monotonic() + 0.1)
            observation = ros.observations.snapshot()
            if observation is not None:
                journal.observation(observation)
            if telemetry_epoch != state["mqtt_epoch"]:
                telemetry_epoch = state["mqtt_epoch"]
                telemetry_due.clear()
                telemetry_inflight = None
            if telemetry_inflight and telemetry_inflight.is_published():
                telemetry_inflight = None  # PUBACKだけではSQLiteから削除しない。
            if state["mqtt_subscribed"] and telemetry_inflight is None:
                pending_rows = journal.pending_observations()
                live_ids = {row[0] for row in pending_rows}
                telemetry_due = {key: due for key, due in telemetry_due.items() if key in live_ids}
                for key, body in pending_rows:
                    if time.monotonic() >= telemetry_due.get(key, 0):
                        telemetry_inflight = transport.publish_observation(body)
                        telemetry_due[key] = time.monotonic() + 5
                        break
            if inflight and inflight[1].is_published():
                journal.status_sent(inflight[0])
                inflight = None
            pending = journal.pending_status()
            if pending and not inflight and state["mqtt_subscribed"]:
                info = transport.publish_status(pending)
                if info:
                    inflight = (pending, info)
            stopping.wait(0.05)
    except JournalError as error:
        print(json.dumps({"event": "BRIDGE_FAILED", "reason": str(error)}), flush=True)
        exit_code = 1
    except Exception:
        # SDK、SQLite、rclpyの例外はendpoint/認証file名/本文を含み得る。
        print(json.dumps({"event": "BRIDGE_FAILED", "reason": "RUNTIME_UNAVAILABLE"}), flush=True)
        exit_code = 1
    finally:
        if transport:
            transport.stop_intake()
        if journal:
            try:
                state = {"device_id": config.device_id, "ready": False,
                         "accepting_operations": False, "stopping": True,
                         "reason": "SHUTDOWN" if exit_code == 0 else "JOURNAL_OR_RUNTIME_FAILED"}
                health_file(config, state)
                if transport:
                    receive_pending(transport, journal, deadline=time.monotonic() + 3)
                    if not transport.inbox.empty():
                        exit_code = 1
                        state["reason"] = "INBOX_PENDING_REDELIVERY"
                        health_file(config, state)
                message = status_message(config.device_id, "OFFLINE", "SHUTDOWN")
                journal.status(message)
                journal.record(state)
                if transport and transport.snapshot()["mqtt_subscribed"]:
                    body = journal.pending_status()
                    info = transport.publish_status(body)
                    if info:
                        try:
                            info.wait_for_publish(timeout=1)
                            if info.is_published():
                                journal.status_sent(body)
                        except RuntimeError:
                            pass  # 未送信statusはSQLiteに残す
            except Exception:
                exit_code = 1
        for resource in (ros, transport, journal):
            if resource:
                try:
                    resource.close()
                except Exception:
                    exit_code = 1
        rclpy.try_shutdown()
        print(json.dumps({"event": "BRIDGE_STOPPED", "exit_code": exit_code}), flush=True)
    return exit_code


def main():
    os.umask(0o077)
    try:
        config = load_config()
    except ConfigurationError as error:
        print(json.dumps({"event": "BRIDGE_CONFIGURATION_INVALID", "field": str(error)}),
              flush=True)
        return 2
    os.environ.setdefault("ROS_DOMAIN_ID", "42")
    os.environ.setdefault("ROS_AUTOMATIC_DISCOVERY_RANGE", "LOCALHOST")
    os.environ.setdefault("ROS_STATIC_PEERS", "")
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda _sig, _frame: stopping.set())
    signal.signal(signal.SIGINT, lambda _sig, _frame: stopping.set())
    return run(config, stopping)


if __name__ == "__main__":
    sys.exit(main())
