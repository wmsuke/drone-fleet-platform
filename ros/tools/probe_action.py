"""E2Eの読み取り専用probe。goal送信・heartbeat/cancelを行わない。"""

import json
import os
import sys
import time
import uuid

from fleet_bridge_interfaces.action import ReturnHome
from fleet_bridge_interfaces.srv import GetRuntimeState
from fleet_reference.model import namespace
import rclpy
from rclpy.node import Node
from unique_identifier_msgs.msg import UUID


def query(node, service_type, name, request):
    client = node.create_client(service_type, name)
    # 読み取り専用照会だけを最大3回/合計12秒で再試行する。discoveryが
    # service-readyでも初回responseが届かない場合がある。goalは再送しない。
    deadline = time.monotonic() + 12
    for attempt in range(3):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        if not client.wait_for_service(timeout_sec=min(3, remaining)):
            print(f"DDS_READ_RETRY {name} discovery attempt={attempt + 1}",
                  file=sys.stderr, flush=True)
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        future = client.call_async(request)
        rclpy.spin_until_future_complete(node, future, timeout_sec=min(3, remaining))
        if future.done():
            return future.result()
        client.remove_pending_request(future)
        future.cancel()
        print(f"DDS_READ_RETRY {name} response attempt={attempt + 1}",
              file=sys.stderr, flush=True)
    raise RuntimeError(f"bounded read unavailable: {name}")


def main():
    device = sys.argv[1]
    rclpy.init()
    node = Node("fleet_e2e_readonly_probe_" + uuid.uuid4().hex)
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
        print(json.dumps(result), flush=True)
    except Exception as error:
        print(f"DDS_READ_UNAVAILABLE {type(error).__name__}: {error}",
              file=sys.stderr, flush=True)
        os._exit(1)
    # 読み取り専用の使い捨てprocess。DDS照会後のRMW終了待ちに試験を依存させない。
    # heartbeat/goal/DB書込を持たず、socket等はOSで回収する。Bridgeの終了試験とは別。
    os._exit(0)


if __name__ == "__main__":
    main()
