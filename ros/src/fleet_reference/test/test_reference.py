"""別processの実ROS serverへ接続して外から観測する。"""

import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

import pytest
import rclpy
from rclpy.action import ActionClient
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from action_msgs.msg import GoalStatus
from sensor_msgs.msg import BatteryState
from nav_msgs.msg import Odometry
from diagnostic_msgs.msg import DiagnosticArray

from fleet_bridge_interfaces.action import ReturnHome
from fleet_bridge_interfaces.msg import BridgeHeartbeat
from fleet_bridge_interfaces.srv import GetRuntimeState
from fleet_reference.model import Config, Vehicle, load_configs, namespace
from fleet_reference.nodes import ros_uuid, sensor_qos, state_qos, utc


def wait(predicate, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("bounded wait expired")


def completed(future, timeout=10):
    wait(future.done, timeout)
    return future.result()


@pytest.fixture
def runtime(tmp_path):
    rclpy.init()
    node = Node("reference_probe_" + uuid.uuid4().hex)
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(node)
    thread = threading.Thread(target=executor.spin)
    thread.start()
    processes = []

    def start(configs, domain=None):
        config = tmp_path / f"config-{len(processes)}.json"
        config.write_text(json.dumps({"devices": configs}))
        log = (tmp_path / f"server-{len(processes)}.log").open("w+")
        env = dict(os.environ)
        if domain is not None:
            env["ROS_DOMAIN_ID"] = str(domain)
        process = subprocess.Popen(
            [sys.executable, "-m", "fleet_reference.cli", "--config", str(config)],
            stdout=log, stderr=subprocess.STDOUT, env=env,
        )
        processes.append((process, log))
        if domain is not None:
            wait(lambda: "REFERENCE_READY" in Path(log.name).read_text())
        return process

    yield node, start
    errors = []
    for process, log in processes:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            errors.append("reference process required forced shutdown")
        log.seek(0)
        output = log.read()
        print(output)
        log.close()
        if process.returncode not in (0, 72):
            errors.append(f"unexpected server exit: {process.returncode}")
        if "Traceback" in output or "exception was never retrieved" in output:
            errors.append(output)
    executor.shutdown(timeout_sec=5)
    thread.join(timeout=5)
    node.destroy_node()
    rclpy.shutdown()
    assert not thread.is_alive()
    assert not errors


class Probe:
    def __init__(self, node, device):
        self.node = node
        self.device = device
        ns = namespace(device)
        self.service = node.create_client(GetRuntimeState, ns + "/get_runtime_state")
        assert self.service.wait_for_service(timeout_sec=10)
        self.publisher = node.create_publisher(
            BridgeHeartbeat, ns + "/bridge_heartbeat", state_qos(),
        )
        self.state = self.get_state()
        self.goal_id = None
        self.enabled = True
        self.timer = node.create_timer(1.0, self.beat)
        self.beat()
        wait(lambda: self.get_state().ready)
        self.action = ActionClient(
            node, ReturnHome, ns + "/return_home",
            feedback_sub_qos_profile=QoSProfile(
                depth=10, reliability=ReliabilityPolicy.BEST_EFFORT,
            ),
        )
        assert self.action.wait_for_server(timeout_sec=10)
        self.feedback = []

    def get_state(self):
        request = GetRuntimeState.Request()
        request.device_id = self.device
        response = completed(self.service.call_async(request))
        assert response.valid
        return response.state

    def beat(self):
        if not self.enabled:
            return
        message = BridgeHeartbeat()
        message.header.stamp = self.node.get_clock().now().to_msg()
        message.device_id = self.device
        message.owner_id = "reference-smoke"
        message.server_instance_id = self.state.server_instance_id
        message.expected_configuration_id = self.state.configuration_id
        message.has_goal = self.goal_id is not None
        message.goal_id = ros_uuid(self.goal_id)
        self.publisher.publish(message)

    def send(self, change=None):
        identifier = uuid.uuid4()
        request = ReturnHome.Goal()
        request.device_id = self.device
        request.command_id = str(uuid.uuid4())
        request.goal_id = ros_uuid(identifier)
        request.server_instance_id = self.state.server_instance_id
        request.expected_configuration_id = self.state.configuration_id
        request.home_id = self.state.home_id
        request.frame_id = self.state.header.frame_id
        request.expires_at = utc()
        request.expires_at.sec += 30
        request.result_deadline = utc()
        request.result_deadline.sec += 120
        if change:
            change(request)
        handle = completed(self.action.send_goal_async(
            request, goal_uuid=ros_uuid(identifier),
            feedback_callback=lambda message: self.feedback.append(message.feedback),
        ))
        if handle.accepted:
            self.goal_id = identifier
            self.beat()
        return handle

    def result(self, handle):
        result = completed(handle.get_result_async())
        self.goal_id = None
        self.beat()
        return result


def test_seed_and_namespace(tmp_path):
    a, b = Vehicle(Config("a")), Vehicle(Config("a"))
    assert a.home == b.home and a.position == b.position
    assert a.home != Vehicle(Config("a", seed=191)).home
    assert namespace("a-b") != namespace("a_b")
    for values in [{"seed": -1}, {"scenario": "unknown"}, {"battery_percentage": math.nan}]:
        with pytest.raises(ValueError):
            Config("a", **values)
    config = tmp_path / "config.json"
    config.write_text('{"devices":[{"device_id":"a"},{"device_id":"a"}]}')
    with pytest.raises(ValueError):
        load_configs(config)


def test_two_devices_topics_and_success(runtime):
    node, start = runtime
    start([{"device_id": "success-a"}, {"device_id": "success-b", "temperature": None}])
    a, b = Probe(node, "success-a"), Probe(node, "success-b")
    received = {}
    subscriptions = []
    for probe in [a, b]:
        for topic, message_type, qos in [
            ("battery", BatteryState, sensor_qos()),
            ("odometry", Odometry, sensor_qos()),
            ("diagnostics", DiagnosticArray, state_qos(10)),
        ]:
            key = (probe.device, topic)
            subscriptions.append(node.create_subscription(
                message_type, namespace(probe.device) + "/" + topic,
                lambda msg, key=key: received.update({key: msg}), qos,
            ))
    wait(lambda: len(received) == 6)
    assert math.isnan(received[("success-b", "battery")].temperature)
    for probe in [a, b]:
        assert received[(probe.device, "battery")].percentage == pytest.approx(0.8)
        assert received[(probe.device, "odometry")].header.frame_id == probe.state.header.frame_id
        assert received[(probe.device, "diagnostics")].status[0].hardware_id == probe.device
    handle = a.send()
    assert handle.accepted
    result = a.result(handle)
    assert result.status == GoalStatus.STATUS_SUCCEEDED
    assert result.result.started and result.result.started_at.sec > 0
    assert result.result.home_distance_m <= 0.2
    assert result.result.stable_duration_s >= 1
    assert result.result.final_velocity.twist.linear.x == 0
    assert result.result.configuration_id == a.state.configuration_id
    assert a.feedback and a.feedback[0].goal_id == handle.goal_id
    assert b.get_state().execution_count == 0
    assert a.get_state().execution_count == 1
    assert not any(name.endswith("/fix") for name, _ in node.get_topic_names_and_types())


@pytest.mark.parametrize("scenario", [
    "reject", "abort", "delayed_cancel", "cancel_reject", "unresponsive", "disconnect",
])
def test_action_scenarios(runtime, scenario):
    node, start = runtime
    device = "case-" + scenario
    process = start([{"device_id": device, "scenario": scenario}])
    probe = Probe(node, device)
    handle = probe.send()
    if scenario == "reject":
        assert not handle.accepted
        assert probe.get_state().execution_count == 0
        return
    assert handle.accepted
    future = handle.get_result_async()
    if scenario in ("unresponsive", "disconnect"):
        if scenario == "disconnect":
            wait(lambda: process.poll() is not None)
            assert process.returncode == 72
        else:
            assert probe.get_state().has_active_goal
        time.sleep(0.5)
        assert not future.done()
        return
    if scenario in ("delayed_cancel", "cancel_reject"):
        wait(lambda: probe.feedback)
        cancel_at = time.monotonic()
        response = completed(handle.cancel_goal_async())
        if scenario == "delayed_cancel":
            assert response.goals_canceling
            assert not future.done()  # cancel受付は終端ではない
        else:
            assert not response.goals_canceling
    response = completed(future)
    expected = {"abort": GoalStatus.STATUS_ABORTED,
                "delayed_cancel": GoalStatus.STATUS_CANCELED,
                "cancel_reject": GoalStatus.STATUS_SUCCEEDED}[scenario]
    assert response.status == expected
    if scenario == "delayed_cancel":
        assert time.monotonic() - cancel_at >= 1.5
    if scenario == "abort":
        assert response.result.reason == "INJECTED_FAILURE"
    assert response.result.started
    assert response.result.final_velocity.twist.linear.x == 0


@pytest.mark.parametrize("first_format", ["canonical", "upper", "hex"])
def test_command_uuid_spellings_cannot_replay_completed_goal(runtime, first_format):
    node, start = runtime
    device = "replay-" + first_format
    start([{"device_id": device}])
    probe = Probe(node, device)
    command = uuid.UUID("a1234567-89ab-4cde-8fab-0123456789ab")
    spellings = {"canonical": str(command), "upper": str(command).upper(), "hex": command.hex}
    handle = probe.send(lambda goal: setattr(goal, "command_id", spellings[first_format]))
    assert handle.accepted
    assert probe.result(handle).status == GoalStatus.STATUS_SUCCEEDED
    assert probe.get_state().ready  # 実行中のDEVICE_BUSYによる拒否ではない
    for spelling in spellings.values():
        # sendごとに異なるtransport/payload goal UUIDを用いる。
        duplicate = probe.send(lambda goal: setattr(goal, "command_id", spelling))
        assert not duplicate.accepted
        state = probe.get_state()
        assert state.reason == "COMMAND_REPLAY_OR_FULL"
        assert state.accepted_count == 1 and state.execution_count == 1
    # 重複でないcommandは引き続き受け付けられる。
    fresh = probe.send()
    assert fresh.accepted
    assert probe.result(fresh).status == GoalStatus.STATUS_SUCCEEDED
    state = probe.get_state()
    assert state.accepted_count == 2 and state.execution_count == 2


def test_invalid_goal_and_domain_isolation(runtime):
    node, start = runtime
    start([{"device_id": "validation"}])
    probe = Probe(node, "validation")
    for field in ["frame_id", "server_instance_id", "expected_configuration_id", "device_id"]:
        assert not probe.send(lambda goal: setattr(goal, field, "wrong")).accepted
    assert not probe.send(lambda goal: setattr(goal.expires_at, "sec", 1)).accepted
    assert probe.get_state().execution_count == 0
    start([{"device_id": "other-domain"}], domain=43)
    service = node.create_client(GetRuntimeState, namespace("other-domain") + "/get_runtime_state")
    assert not service.wait_for_service(timeout_sec=2)
