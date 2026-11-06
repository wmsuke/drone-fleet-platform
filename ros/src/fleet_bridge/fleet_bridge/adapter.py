"""機体Adapterのidentity検査。操作やheartbeatによるowner取得はまだ行わない。"""

import re
import uuid


def matches_runtime(config, response):
    state = response.state
    try:
        uuid.UUID(state.server_instance_id)
    except ValueError:
        return False
    return bool(
        response.valid and state.device_id == config.device_id
        and state.header.frame_id == config.namespace[1:] + "/map"
        and state.home_pose.header.frame_id == state.header.frame_id
        and re.fullmatch(r"[0-9a-f]{64}", state.configuration_id)
    )
