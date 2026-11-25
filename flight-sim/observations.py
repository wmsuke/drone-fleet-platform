"""Normalize observations from the pinned X3 world for the Fleet ROS Bridge."""

import math
import re

from nav_msgs.msg import Odometry
from rclpy.duration import Duration
from rclpy.qos import QoSProfile, ReliabilityPolicy


def fleet_namespace(device_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", device_id):
        raise ValueError("invalid Fleet device ID")
    return "/fleet/d_" + device_id.encode("ascii").hex()


def normalize_odometry(message, namespace):
    # The pinned 3D plugin publishes world pose and model-body twist with
    # identity offsets. base_link here is the model origin, not a ground projection.
    if (message.header.frame_id, message.child_frame_id) != ("x3/odom", "x3/base_footprint"):
        return None
    stamp = message.header.stamp
    if stamp.sec < 0 or not 0 <= stamp.nanosec < 1_000_000_000:
        return None
    for vector in (message.pose.pose.position, message.twist.twist.linear,
                   message.twist.twist.angular):
        if not all(math.isfinite(value) for value in (vector.x, vector.y, vector.z)):
            return None
    orientation = message.pose.pose.orientation
    if not math.isclose(math.hypot(orientation.x, orientation.y, orientation.z, orientation.w),
                        1.0, abs_tol=1e-6):
        return None
    observation = Odometry()
    observation.header.stamp = stamp
    observation.header.frame_id = namespace[1:] + "/map"
    observation.child_frame_id = namespace[1:] + "/base_link"
    observation.pose = message.pose
    observation.twist = message.twist
    return observation


def publisher(node, namespace):
    qos = QoSProfile(depth=5, reliability=ReliabilityPolicy.BEST_EFFORT,
                     deadline=Duration(seconds=2))
    return node.create_publisher(Odometry, namespace + "/odometry", qos)
