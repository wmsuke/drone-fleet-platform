"""ROS transportから独立した、boundedな参照状態と設定。"""

from dataclasses import asdict, dataclass
import hashlib
import json
import math
import random
import re

SCENARIOS = {
    "success", "reject", "abort", "unresponsive", "delayed_cancel",
    "cancel_reject", "disconnect",
}


def namespace(device_id):
    if not isinstance(device_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", device_id):
        raise ValueError("invalid device_id")
    return "/fleet/d_" + device_id.encode("ascii").hex()


@dataclass(frozen=True)
class Config:
    device_id: str
    seed: int = 190
    scenario: str = "success"
    cancel_delay_sec: float = 1.5
    failure_after_sec: float = 0.4
    battery_percentage: float = 0.8
    temperature: float | None = 24.0
    result_cache_sec: float = 900.0

    def __post_init__(self):
        namespace(self.device_id)
        if self.scenario not in SCENARIOS:
            raise ValueError("unknown scenario")
        if type(self.seed) is not int or not 0 <= self.seed <= 2**32 - 1:
            raise ValueError("seed must be uint32")
        for value, low, high in [
            (self.cancel_delay_sec, 0, 5), (self.failure_after_sec, 0.1, 10),
            (self.battery_percentage, 0, 1),
            (self.result_cache_sec, 0.1, 900),
        ]:
            if (type(value) not in (int, float)
                    or not math.isfinite(value) or not low <= value <= high):
                raise ValueError("invalid numeric configuration")
        if self.temperature is not None and (
            type(self.temperature) not in (int, float) or not math.isfinite(self.temperature)
        ):
            raise ValueError("invalid temperature")

    @property
    def digest(self):
        data = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(data.encode()).hexdigest()


def load_configs(path):
    with open(path, encoding="utf8") as source:
        data = json.load(source)
    if set(data) != {"devices"} or not isinstance(data["devices"], list):
        raise ValueError("devices array required")
    configs = [Config(**value) for value in data["devices"]]
    if not 1 <= len(configs) <= 10:
        raise ValueError("1 to 10 devices required")
    if len({c.device_id for c in configs}) != len(configs):
        raise ValueError("duplicate device_id")
    return configs


class Vehicle:
    def __init__(self, config):
        self.config = config
        rng = random.Random(config.seed)
        # 起動時の参照poseをhomeに固定し、試験用の出発位置へ置く。
        self.home = [rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1), 0.0]
        self.departure = [self.home[0] + 2.0, self.home[1] + rng.uniform(0.1, 0.3), 0.4]
        self.position = list(self.departure)
        self.velocity = [0.0, 0.0, 0.0]
        self.status = "FLYING"

    @property
    def distance(self):
        return math.dist(self.position, self.home)

    def move_home(self, elapsed):
        distance = math.dist(self.departure, self.home)
        if distance == 0:
            self.stop()
            return
        ratio = min(1.0, elapsed / distance)
        self.position = [a + (b - a) * ratio for a, b in zip(self.departure, self.home)]
        self.velocity = [
            (b - a) / distance if ratio < 1 else 0.0
            for a, b in zip(self.departure, self.home)
        ]
        self.status = "RETURNING_HOME" if ratio < 1 else "IDLE"

    def stop(self):
        self.velocity = [0.0, 0.0, 0.0]
        self.status = "IDLE"
