"""ROS executor。callback内で同期service/action待ちをしない。"""

import threading
import time

from fleet_bridge_interfaces.action import ReturnHome
from fleet_bridge_interfaces.srv import GetRuntimeState
import rclpy
from rclpy.action import ActionClient
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from rclpy.signals import SignalHandlerOptions

from .adapter import matches_runtime


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
        except Exception:
            with self.guard:
                self.available = False
                self.last_response = 0
                self.reason = "ROS_EXECUTOR_FAILED"

    def snapshot(self):
        with self.guard:
            fresh = time.monotonic() - self.last_response < 3
            return {"ros_available": self.available and fresh,
                    "ros_reason": self.reason if fresh else "ROS_UNAVAILABLE"}

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
