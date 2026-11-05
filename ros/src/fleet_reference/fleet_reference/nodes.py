"""ROS publisher/service/Action。永続Bridge・実機制御は含まない。"""

import math
import os
import threading
import time
import uuid

from builtin_interfaces.msg import Time
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus
from fleet_bridge_interfaces.action import ReturnHome
from fleet_bridge_interfaces.msg import BridgeHeartbeat, RuntimeState
from fleet_bridge_interfaces.srv import GetRuntimeState
from geometry_msgs.msg import PoseStamped, TwistStamped
from nav_msgs.msg import Odometry
import rclpy
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import BatteryState
from unique_identifier_msgs.msg import UUID

from .model import Vehicle, namespace


def sensor_qos():
    return QoSProfile(
        depth=5, reliability=ReliabilityPolicy.BEST_EFFORT,
        durability=DurabilityPolicy.VOLATILE, deadline=Duration(seconds=2),
    )


def state_qos(depth=1):
    return QoSProfile(
        depth=depth, reliability=ReliabilityPolicy.RELIABLE,
        durability=DurabilityPolicy.VOLATILE, deadline=Duration(seconds=2),
    )


def utc():
    value = time.time_ns()
    return Time(sec=value // 1_000_000_000, nanosec=value % 1_000_000_000)


def seconds(value):
    return value.sec + value.nanosec / 1_000_000_000


def ros_uuid(value=None):
    return UUID(uuid=list(value.bytes) if value else [0] * 16)


class State:
    def __init__(self, config):
        self.stopping = False
        self.config = config
        self.vehicle = Vehicle(config)
        self.lock = threading.RLock()
        self.server_id = str(uuid.uuid4())
        self.home_id = "home-" + self.server_id
        self.frame = namespace(config.device_id)[1:] + "/map"
        self.base_frame = namespace(config.device_id)[1:] + "/base_link"
        self.active = None
        self.last_terminal = None
        self.heartbeat_at = 0.0
        self.owner = None
        self.last_sample = 0.0
        self.accepted = 0
        self.executions = 0
        self.reason = "BOOTING"
        self.commands = set()

    def check(self):
        if time.monotonic() - self.heartbeat_at >= 3:
            return "BRIDGE_WATCHDOG"
        if time.monotonic() - self.last_sample >= 3:
            return "SENSOR_STALE"
        if self.config.battery_percentage < 0.2:
            return "LOW_BATTERY"
        if self.vehicle.distance > 10:
            return "POLICY_REJECTED"
        return None

    def pose(self, stamp):
        message = PoseStamped()
        message.header.stamp = stamp
        message.header.frame_id = self.frame
        p = message.pose.position
        p.x, p.y, p.z = self.vehicle.position
        message.pose.orientation.w = 1.0
        return message

    def velocity(self, stamp):
        message = TwistStamped()
        message.header.stamp = stamp
        message.header.frame_id = self.frame
        v = message.twist.linear
        v.x, v.y, v.z = self.vehicle.velocity
        return message


class ReferenceVehicle(Node):
    def __init__(self, state):
        super().__init__("reference_vehicle", namespace=namespace(state.config.device_id))
        self.state = state
        self.odometry = self.create_publisher(Odometry, "odometry", sensor_qos())
        self.battery = self.create_publisher(BatteryState, "battery", sensor_qos())
        self.diagnostics = self.create_publisher(DiagnosticArray, "diagnostics", state_qos(10))
        self.create_timer(0.1, self.publish_odometry)
        self.create_timer(1.0, self.publish_sensors)

    def publish_odometry(self):
        with self.state.lock:
            stamp = self.get_clock().now().to_msg()
            message = Odometry()
            message.header.stamp = stamp
            message.header.frame_id = self.state.frame
            message.child_frame_id = self.state.base_frame
            message.pose.pose = self.state.pose(stamp).pose
            # 参照の移動はx軸主体でbody姿勢は単位quaternionとし、両frameの軸を一致させる。
            message.twist.twist = self.state.velocity(stamp).twist
            self.odometry.publish(message)
            self.state.last_sample = time.monotonic()

    def publish_sensors(self):
        with self.state.lock:
            stamp = self.get_clock().now().to_msg()
            message = BatteryState()
            message.header.stamp = stamp
            message.header.frame_id = self.state.base_frame
            message.voltage = 12.0
            message.percentage = float(self.state.config.battery_percentage)
            temperature = self.state.config.temperature
            message.temperature = float(temperature) if temperature is not None else math.nan
            message.present = True
            message.current = math.nan
            message.charge = math.nan
            message.capacity = math.nan
            message.design_capacity = math.nan
            self.battery.publish(message)
            diagnostics = DiagnosticArray()
            diagnostics.header.stamp = stamp
            diagnostics.header.frame_id = self.state.base_frame
            status = DiagnosticStatus()
            status.name = "reference_vehicle"
            status.hardware_id = self.state.config.device_id
            status.level = DiagnosticStatus.OK if not self.state.check() else DiagnosticStatus.WARN
            status.message = self.state.check() or "READY"
            diagnostics.status = [status]
            self.diagnostics.publish(diagnostics)


class ReferenceAdapter(Node):
    def __init__(self, state):
        super().__init__("reference_adapter", namespace=namespace(state.config.device_id))
        self.state = state
        group = ReentrantCallbackGroup()
        self.runtime = self.create_publisher(RuntimeState, "runtime_state", state_qos())
        self.create_timer(1.0, lambda: self.runtime.publish(self.snapshot()))
        self.create_subscription(
            BridgeHeartbeat, "bridge_heartbeat", self.heartbeat, state_qos(),
            callback_group=group,
        )
        self.create_service(
            GetRuntimeState, "get_runtime_state", self.get_state, callback_group=group,
        )
        feedback_qos = QoSProfile(
            depth=10, reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )
        self.action = ActionServer(
            self, ReturnHome, "return_home", execute_callback=self.execute,
            goal_callback=self.goal, cancel_callback=self.cancel, callback_group=group,
            feedback_pub_qos_profile=feedback_qos, result_timeout=900,
        )

    def heartbeat(self, message):
        with self.state.lock:
            s = self.state
            expected_goal = ros_uuid(s.active)
            if (
                message.device_id != s.config.device_id
                or message.server_instance_id != s.server_id
                or message.expected_configuration_id != s.config.digest
                or not message.owner_id
                or (s.owner and message.owner_id != s.owner)
                or message.has_goal != (s.active is not None)
                or (message.has_goal and message.goal_id != expected_goal)
            ):
                return
            s.owner = message.owner_id
            s.heartbeat_at = time.monotonic()

    def snapshot(self):
        with self.state.lock:
            s = self.state
            message = RuntimeState()
            stamp = self.get_clock().now().to_msg()
            message.header.stamp = stamp
            message.header.frame_id = s.frame
            message.device_id = s.config.device_id
            message.server_instance_id = s.server_id
            message.configuration_id = s.config.digest
            message.home_id = s.home_id
            message.home_pose = s.pose(stamp)
            p = message.home_pose.pose.position
            p.x, p.y, p.z = s.vehicle.home
            message.has_active_goal = s.active is not None
            message.active_goal_id = ros_uuid(s.active)
            message.has_last_terminal_goal = s.last_terminal is not None
            message.last_terminal_goal_id = ros_uuid(s.last_terminal)
            message.flight_status = s.vehicle.status
            message.reason = s.reason
            message.ready = s.check() is None and s.active is None
            message.accepted_count = s.accepted
            message.execution_count = s.executions
            return message

    def get_state(self, request, response):
        response.valid = request.device_id == self.state.config.device_id
        response.state = self.snapshot()
        return response

    def goal(self, request):
        with self.state.lock:
            s = self.state
            try:
                command = uuid.UUID(request.command_id)
                canonical_command = str(command)
                goal = uuid.UUID(bytes=bytes(request.goal_id.uuid))
                identifiers_valid = command.version == 4 and goal.version == 4
            except ValueError:
                identifiers_valid = False
            if not identifiers_valid or request.device_id != s.config.device_id:
                s.reason = "INVALID_GOAL"
            elif s.active is not None:
                s.reason = "DEVICE_BUSY"
            elif len(s.commands) >= 10000 or canonical_command in s.commands:
                s.reason = "COMMAND_REPLAY_OR_FULL"
            elif (
                request.server_instance_id != s.server_id
                or request.expected_configuration_id != s.config.digest
                or request.home_id != s.home_id or request.frame_id != s.frame
            ):
                s.reason = "CONFIGURATION_MISMATCH"
            elif time.time() >= seconds(request.expires_at):
                s.reason = "REJECTED_EXPIRED"
            elif seconds(request.result_deadline) <= seconds(request.expires_at):
                s.reason = "INVALID_DEADLINE"
            elif s.config.scenario == "reject":
                s.reason = "INJECTED_REJECT"
            elif s.check():
                s.reason = s.check()
            else:
                s.active = goal
                s.commands.add(canonical_command)
                s.accepted += 1
                s.reason = "GOAL_ACCEPTED"
                return GoalResponse.ACCEPT
            return GoalResponse.REJECT

    def cancel(self, handle):
        if self.state.config.scenario == "cancel_reject":
            return CancelResponse.REJECT
        return CancelResponse.ACCEPT

    def finish(self, handle, status, reason, started, stable):
        with self.state.lock:
            s = self.state
            s.vehicle.stop()
            s.reason = reason
            s.last_terminal = s.active
            s.active = None
            result = ReturnHome.Result()
            result.goal_id = handle.goal_id
            result.server_instance_id = s.server_id
            result.configuration_id = s.config.digest
            result.started = started is not None
            result.started_at = started or Time()
            result.finished_at = utc()
            result.reason = reason
            result.final_pose = s.pose(self.get_clock().now().to_msg())
            result.final_velocity = s.velocity(self.get_clock().now().to_msg())
            result.home_distance_m = s.vehicle.distance
            result.stable_duration_s = stable
            getattr(handle, status)()
            return result

    def execute(self, handle):
        started = None
        stable_since = None
        cancel_since = None
        start = time.monotonic()
        request = handle.request
        with self.state.lock:
            if handle.goal_id != request.goal_id:
                return self.finish(handle, "abort", "GOAL_ID_MISMATCH", None, 0.0)
            if time.time() >= seconds(request.expires_at):
                return self.finish(handle, "abort", "REJECTED_EXPIRED", None, 0.0)
            self.state.executions += 1
            self.state.vehicle.departure = list(self.state.vehicle.position)
            started = utc()
        while rclpy.ok() and not self.state.stopping:
            elapsed = time.monotonic() - start
            with self.state.lock:
                s = self.state
                if elapsed >= 60 or time.time() >= seconds(request.result_deadline):
                    return self.finish(handle, "abort", "RESULT_DEADLINE", started, 0.0)
                if s.check():
                    return self.finish(handle, "abort", s.check(), started, 0.0)
                if s.config.scenario == "disconnect" and elapsed >= s.config.failure_after_sec:
                    # 切断fixture。終端resultを送らずOS processを終了する。
                    os._exit(72)
                if s.config.scenario == "abort" and elapsed >= s.config.failure_after_sec:
                    return self.finish(handle, "abort", "INJECTED_FAILURE", started, 0.0)
                if s.config.scenario != "unresponsive":
                    s.vehicle.move_home(elapsed)
                    if handle.is_cancel_requested:
                        cancel_since = cancel_since or time.monotonic()
                        delayed = s.config.scenario == "delayed_cancel"
                        delay = s.config.cancel_delay_sec if delayed else 0
                        if time.monotonic() - cancel_since >= delay:
                            return self.finish(handle, "canceled", "CANCELLED", started, 0.0)
                    speed = math.dist(s.vehicle.velocity, [0, 0, 0])
                    if s.vehicle.distance <= 0.2 and speed <= 0.05:
                        stable_since = stable_since or time.monotonic()
                        stable = time.monotonic() - stable_since
                        if stable >= 1:
                            return self.finish(handle, "succeed", "HOME_REACHED", started, stable)
                    else:
                        stable_since = None
                    feedback = ReturnHome.Feedback()
                    feedback.goal_id = handle.goal_id
                    feedback.server_instance_id = s.server_id
                    feedback.configuration_id = s.config.digest
                    feedback.started_at = started
                    feedback.phase = "RETURNING_HOME"
                    feedback.distance_m = s.vehicle.distance
                    handle.publish_feedback(feedback)
            time.sleep(0.1)
        return self.finish(handle, "abort", "SERVER_SHUTDOWN", started, 0.0)

    def destroy_node(self):
        self.action.destroy()
        super().destroy_node()
