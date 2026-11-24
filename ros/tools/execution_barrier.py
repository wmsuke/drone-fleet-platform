"""実ROS障害E2Eのwrapper専用。通常packageには組み込まない。"""

import json
import os
from pathlib import Path
import signal
import uuid


BARRIER_PATH = Path("/tmp/fleet-reference-execution-barrier.json")


def execution_barrier(state, handle):
    device = state.config.device_id
    if (os.environ.get("BRIDGE_INTEGRATION") != "true"
            or os.environ.get("REFERENCE_TEST_EXECUTION_BARRIER") != device
            or device != "ros-recovery-generation"):
        return
    # execute開始後、watchdog/結果生成へ進む前にserver全体を止める。
    # 機体側の閾値を緩めず、実process停止で未終端goalを維持する。
    evidence = {"deviceId": device, "commandId": handle.request.command_id,
                "goalId": str(uuid.UUID(bytes=bytes(handle.goal_id.uuid))),
                "serverInstanceId": state.server_id, "pid": os.getpid(),
                "acceptedCount": state.accepted, "executionCount": state.executions,
                "rosStatus": int(handle.status), "hasTerminal": state.last_terminal is not None}
    temporary = BARRIER_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(evidence), encoding="utf8")
    temporary.replace(BARRIER_PATH)
    os.kill(os.getpid(), signal.SIGSTOP)
