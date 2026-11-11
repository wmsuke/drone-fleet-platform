"""試験専用。終端済みgoalのfeedbackを実DDSへ遅着させる。goalは送らない。"""

from datetime import datetime
import json
import os
import sys
import time
import uuid

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from fleet_bridge_interfaces.action import ReturnHome
from fleet_reference.model import namespace
from fleet_reference.nodes import ros_uuid


def main():
    source = json.loads(sys.argv[1])
    device = source["deviceId"]
    if os.environ.get("BRIDGE_INTEGRATION") != "true" or not device.startswith("ros-command-"):
        raise RuntimeError("test-only feedback injection disabled")
    rclpy.init()
    node = Node("fleet_late_feedback_" + uuid.uuid4().hex)
    publisher = node.create_publisher(
        ReturnHome.Impl.FeedbackMessage, namespace(device) + "/return_home/_action/feedback",
        QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT),
    )
    deadline = time.monotonic() + 8
    while publisher.get_subscription_count() < 1 and time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.1)
    subscribers = publisher.get_subscription_count()
    if not subscribers:
        os._exit(1)
    message = ReturnHome.Impl.FeedbackMessage()
    message.goal_id = ros_uuid(uuid.UUID(source["goalId"]))
    feedback = message.feedback
    feedback.goal_id = message.goal_id
    feedback.server_instance_id = source["serverInstanceId"]
    feedback.configuration_id = source["adapterConfigurationId"]
    stamp = datetime.fromisoformat(source["startedAt"].replace("Z", "+00:00"))
    feedback.started_at.sec = int(stamp.timestamp())
    feedback.started_at.nanosec = stamp.microsecond * 1000
    feedback.phase = "RETURNING_HOME"
    feedback.distance_m = source["distanceMm"] / 1000
    for _ in range(3):
        publisher.publish(message)
        rclpy.spin_once(node, timeout_sec=0.3)
    print(json.dumps({"subscribers": subscribers, "published": 3, "goalId": source["goalId"]}),
          flush=True)
    # 使い捨てpublisherのRMW終了待ちで試験を止めない。socket等はOSで回収する。
    os._exit(0)


if __name__ == "__main__":
    main()
