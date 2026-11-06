"""ROS executor。callback内で同期service/action待ちをしない。"""

import threading
import time
import json

from diagnostic_msgs.msg import DiagnosticArray
from fleet_bridge_interfaces.action import ReturnHome
from fleet_bridge_interfaces.msg import RuntimeState
from nav_msgs.msg import Odometry
from sensor_msgs.msg import BatteryState, NavSatFix
from fleet_bridge_interfaces.srv import GetRuntimeState
import rclpy
from rclpy.action import ActionClient
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from rclpy.signals import SignalHandlerOptions
from rclpy.event_handler import SubscriptionEventCallbacks
from rclpy.duration import Duration

from .adapter import matches_runtime
from .observations import Observations


class RosClient:
    def __init__(self, config):
        self.config = config
        self.guard = threading.Lock()
        self.available = False
        self.reason = "ROS_DISCOVERING"
        self.last_response = 0.0
        self.pending = None
        self.deadline = 0.0
        self.next_probe = 0.0
        self.failures = 0
        self.closing_at = None
        rclpy.init(signal_handler_options=SignalHandlerOptions.NO)
        self.node = Node("fleet_bridge", namespace=config.namespace)
        self.observations = Observations(config)
        self.subscriptions = []
        for topic, message_type, reliable, depth in (
                ("battery", BatteryState, False, 5), ("odometry", Odometry, False, 5),
                ("fix", NavSatFix, False, 5), ("diagnostics", DiagnosticArray, True, 10),
                ("runtime_state", RuntimeState, True, 1)):
            qos = QoSProfile(depth=depth, deadline=Duration(seconds=2), reliability=(
                ReliabilityPolicy.RELIABLE if reliable else ReliabilityPolicy.BEST_EFFORT))
            self.subscriptions.append(self.node.create_subscription(
                message_type, topic,
                lambda message, name=topic: self.observations.receive(
                    name, message, self.node.get_parameter("use_sim_time").value), qos,
                event_callbacks=SubscriptionEventCallbacks(
                    incompatible_qos=lambda event, name=topic: (
                        self.observations.incompatible(name))),
            ))
        self.group = ReentrantCallbackGroup()
        self.client = self.node.create_client(
            GetRuntimeState, config.namespace + "/get_runtime_state", callback_group=self.group,
        )
        self.action = ActionClient(
            self.node, ReturnHome, config.namespace + "/return_home", callback_group=self.group,
            feedback_sub_qos_profile=QoSProfile(
                depth=10, reliability=ReliabilityPolicy.BEST_EFFORT,
            ),
        )
        self.timer = self.node.create_timer(0.2, self.tick)
        self.executor = MultiThreadedExecutor(num_threads=2)
        self.executor.add_node(self.node)
        self.thread = threading.Thread(target=self.spin, name="bridge-ros")
        self.thread.start()

    def spin(self):
        try:
            while self.closing_at is None or time.monotonic() < self.closing_at + 1:
                self.executor.spin_once(timeout_sec=0.05)
        except Exception as error:
            print(json.dumps({"event": "ROS_EXECUTOR_FAILED", "error_type": type(error).__name__}),
                  flush=True)
            with self.guard:
                self.available = False
                self.last_response = 0
                self.reason = "ROS_EXECUTOR_FAILED"

    def snapshot(self):
        with self.guard:
            fresh = time.monotonic() - self.last_response < 3
            return {"ros_available": self.available and fresh,
                    "ros_reason": self.reason if fresh or self.reason == "ROS_EXECUTOR_FAILED"
                    else "ROS_UNAVAILABLE"}

    def tick(self):
        now = time.monotonic()
        if self.pending:
            if self.pending.done():
                future, self.pending = self.pending, None
                try:
                    valid = matches_runtime(self.config, future.result())
                except Exception:
                    valid = False
                with self.guard:
                    self.available = valid and self.action.server_is_ready()
                    self.reason = "ROS_AVAILABLE" if self.available else "ROS_IDENTITY_OR_TYPE"
                    self.last_response = now
                self.failures = 0
            elif now >= self.deadline:
                self.client.remove_pending_request(self.pending)
                self.pending.cancel()
                self.pending = None
                self.failures += 1
                self.next_probe = now + (8 if self.failures >= 3 else 1)
            return
        if now < self.next_probe:
            return
        self.next_probe = now + 1
        if self.client.service_is_ready():
            request = GetRuntimeState.Request()
            request.device_id = self.config.device_id
            self.pending = self.client.call_async(request)
            self.deadline = now + 2

    def close(self):
        self.timer.cancel()
        self.executor.remove_node(self.node)
        # 固定Jazzyのshutdownでguardより先にcallbackを回収する。
        self.closing_at = time.monotonic()
        self.thread.join(timeout=3)
        self.executor.shutdown(timeout_sec=3)
        if self.pending:
            self.client.remove_pending_request(self.pending)
            self.pending.cancel()
        self.action.destroy()
        self.node.destroy_node()
        rclpy.try_shutdown()
        if self.thread.is_alive():
            raise RuntimeError("ROS_SHUTDOWN_TIMEOUT")
