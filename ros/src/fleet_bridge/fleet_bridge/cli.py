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
from .command_journal import CommandJournal
from .journal import Journal, JournalError
from .ros_client import RosClient
from .transport import MqttTransport, status_message


def health_file(config, state):
    path = config.state_dir / f".health-{os.getpid()}.tmp"
    descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(state, output)
    os.replace(path, config.state_dir / "health.json")


def receive_pending(transport, journal, deadline=None, commands=None):
    for _ in range(transport.config.queue_limit):
        if deadline is not None and time.monotonic() >= deadline:
            break
        try:
            item = transport.inbox.get_nowait()
        except queue.Empty:
            break
        handled = (commands is not None
                   and item[3] == f"fleet/v1/devices/{transport.config.device_id}/commands"
                   and commands.receive(item[4], time.time()))
        if not handled:
            journal.receive(item[3], item[4])
        transport.acknowledge(item)  # SQLite commitより前にPUBACKしない


def run(config, stopping):
    journal = transport = ros = None
    last = None
    inflight = None
    telemetry_inflight = None
    telemetry_due = {}
    telemetry_epoch = None
    report_serial = None
    next_report = 0
    next_event = 0
    event_due = {}
    event_inflight = None
    ack_inflight = None
    commands = None
    exit_code = 0
    try:
        journal = Journal(config)
        commands = CommandJournal(journal)
        commands.recovery()  # SEND_INTENT以後を再送候補にしない。
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
            receive_pending(transport, journal, deadline=time.monotonic() + 0.1,
                            commands=commands)
            observation = ros.observations.snapshot()
            if observation is not None:
                journal.observation(observation)
            reported = ros.configuration_snapshot()
            if reported and reported[0] != report_serial and time.monotonic() >= next_report:
                journal.configuration_report(reported[1])
                report_serial = reported[0]
                next_report = time.monotonic() + 5
            if telemetry_epoch != state["mqtt_epoch"]:
                telemetry_epoch = state["mqtt_epoch"]
                telemetry_due.clear()
                telemetry_inflight = None
                event_due.clear()
                event_inflight = None
                ack_inflight = None
            if ack_inflight and ack_inflight[2].is_published():
                commands.acknowledgement_sent(ack_inflight[0], ack_inflight[1])
                ack_inflight = None
            if state["mqtt_subscribed"] and ack_inflight is None:
                acknowledgements = commands.pending_acknowledgements()
                if acknowledgements:
                    command_id, body = acknowledgements[0]
                    info = transport.publish_acknowledgement(body)
                    if info:
                        ack_inflight = (command_id, body, info)
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
            if event_inflight and event_inflight.is_published():
                event_inflight = None
            if state["mqtt_subscribed"] and event_inflight is None:
                pending_events = journal.pending_bridge_events()
                live_events = {row[0] for row in pending_events}
                event_due = {key: value for key, value in event_due.items() if key in live_events}
                for key, body in pending_events:
                    due, delay = event_due.get(key, (0, 1))
                    if time.monotonic() >= max(due, next_event):
                        event_inflight = transport.publish_bridge_event(body)
                        event_due[key] = (time.monotonic() + delay, min(delay * 2, 8))
                        next_event = time.monotonic() + 0.2
                        break
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
                    receive_pending(transport, journal, deadline=time.monotonic() + 3,
                                    commands=commands)
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
