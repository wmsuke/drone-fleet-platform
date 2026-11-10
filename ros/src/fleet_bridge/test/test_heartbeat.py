"""検証済みgoalの切替を次の旧周期まで遅らせず、失効/取消は送らない。"""

import threading
from types import SimpleNamespace
from unittest.mock import Mock

from builtin_interfaces.msg import Time
from unique_identifier_msgs.msg import UUID

from fleet_bridge.ros_client import RosClient


def test_goal_transition_sends_immediately_without_extending_permission(monkeypatch):
    now = [10.0]
    monkeypatch.setattr("fleet_bridge.ros_client.time.monotonic", lambda: now[0])
    client = RosClient.__new__(RosClient)
    client.guard = threading.Lock()
    client.owner_permission = None
    client.owner_permission_at = 0
    client.next_heartbeat = 0
    client.config = SimpleNamespace(namespace="/fleet/test", device_id="test")
    client.node = Mock()
    client.node.get_clock.return_value.now.return_value.to_msg.return_value = Time()
    client.heartbeat_publisher = Mock()
    state = SimpleNamespace(server_instance_id="server", configuration_id="config",
                            has_active_goal=False, active_goal_id=UUID())
    client.permit_heartbeat("owner", state)
    client.publish_heartbeat(now[0])
    assert client.heartbeat_publisher.publish.call_count == 1
    # 同じidentityを更新しても通常の1秒周期は維持する。
    now[0] = 10.1
    client.permit_heartbeat("owner", state)
    client.publish_heartbeat(now[0])
    assert client.heartbeat_publisher.publish.call_count == 1
    state.has_active_goal = True
    state.active_goal_id = UUID(uuid=[1] * 16)
    client.permit_heartbeat("owner", state)
    client.publish_heartbeat(now[0])
    assert client.heartbeat_publisher.publish.call_count == 2
    sent = client.heartbeat_publisher.publish.call_args.args[0]
    assert sent.has_goal and sent.goal_id == state.active_goal_id
    # タイマだけではpermissionの1.5秒失効を延長しない。
    now[0] = 11.6
    client.publish_heartbeat(now[0])
    assert client.heartbeat_publisher.publish.call_count == 2
    client.permit_heartbeat("owner", state)
    client.permit_heartbeat("owner", None)
    client.publish_heartbeat(now[0])
    assert client.heartbeat_publisher.publish.call_count == 2
