"""E2Eの読み取り専用probe。goal送信・heartbeat/cancelを行わない。"""

import json
import sys
import uuid

from fleet_bridge_interfaces.action import ReturnHome
from fleet_bridge_interfaces.srv import GetRuntimeState
from fleet_reference.model import namespace
import rclpy
from rclpy.node import Node
from unique_identifier_msgs.msg import UUID


def query(node, service_type, name, request):
    client = node.create_client(service_type, name)
    # 別processのDDS discoveryを待つ。機体の状態判定や結果期限は緩めない。
    if not client.wait_for_service(timeout_sec=10):
        raise RuntimeError("service unavailable")
    future = client.call_async(request)
    rclpy.spin_until_future_complete(node, future, timeout_sec=3)
    if not future.done():
        client.remove_pending_request(future)
        future.cancel()
        raise RuntimeError("bounded query timeout")
    return future.result()


def main():
    device = sys.argv[1]
    rclpy.init()
    node = Node("fleet_e2e_readonly_probe")
    try:
        runtime = query(node, GetRuntimeState, namespace(device) + "/get_runtime_state",
                        GetRuntimeState.Request(device_id=device)).state
        result = {"serverInstanceId": runtime.server_instance_id,
                  "acceptedCount": runtime.accepted_count,
                  "executionCount": runtime.execution_count,
                  "hasActiveGoal": runtime.has_active_goal,
                  "activeGoalId": str(uuid.UUID(bytes=bytes(runtime.active_goal_id.uuid))),
                  "lastGoalId": str(uuid.UUID(bytes=bytes(runtime.last_terminal_goal_id.uuid)))}
        if len(sys.argv) > 2:
            request = ReturnHome.Impl.GetResultService.Request()
            request.goal_id = UUID(uuid=list(uuid.UUID(sys.argv[2]).bytes))
            result["resultStatus"] = query(node, ReturnHome.Impl.GetResultService,
                                           namespace(device) + "/return_home/_action/get_result",
                                           request).status
        print(json.dumps(result))
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
