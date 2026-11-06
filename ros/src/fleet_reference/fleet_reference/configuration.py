"""実build・稼働Adapterから能力/構成を報告する。操作readyではない。"""

import hashlib
from importlib.metadata import version, PackageNotFoundError
import json
from pathlib import Path

from .model import namespace


LIMITS = {"minBatteryPercent": 20, "maxDistanceMm": 10000, "sensorFreshnessMs": 3000,
          "heartbeatTimeoutMs": 3000, "positionToleranceMm": 200,
          "stoppedSpeedMmPerSecond": 50, "dwellMs": 1000}


def canonical(value):
    # 構成数値はsafe integerだけ。NaN/floatの言語差を識別子へ持ち込まない。
    def check(item):
        if item is None or type(item) in (bool, str):
            return
        if type(item) is int and abs(item) <= 2**53 - 1:
            return
        if type(item) is list:
            for child in item:
                check(child)
            return
        if type(item) is dict and all(type(key) is str for key in item):
            for child in item.values():
                check(child)
            return
        raise ValueError("unsupported configuration JSON")
    check(value)
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def component(name):
    try:
        manifest = json.loads(Path("/workspace/environment-manifest.json").read_text())
        return {"status": "KNOWN", "id": name, "version": version(name),
                "releaseDigest": manifest["componentSourceSha256"][name]}
    except (OSError, KeyError, PackageNotFoundError):
        return {"status": "UNKNOWN", "reason": "IDENTITY_UNAVAILABLE"}


def configuration(state):
    profile = {"profileId": "reference-return-home", "version": "1.1.0",
               "model": "reference_vehicle", "operations": [
                   {"command": "RETURN_HOME",
                    "actionType": "fleet_bridge_interfaces/action/ReturnHome",
                    "actionName": "return_home"}],
               "frames": {"position": "map", "velocity": "base_link", "convention": "ENU",
                          "positionUnit": "m", "velocityUnit": "m/s", "angularUnit": "rad/s"},
               "requiredSensors": ["battery", "odometry", "runtime_state"],
               "homeDefinition": "SERVER_BOOT_REGISTERED_POSE", "limits": LIMITS,
               "resultCacheMs": round(state.config.result_cache_sec * 1000)}
    if state.config.result_cache_sec != 900:
        profile["profileId"] += "-cache-" + str(profile["resultCacheMs"])
    raw = Path("/workspace/environment-manifest.json").read_bytes()
    manifest = json.loads(raw)

    def policy(name):
        return {"status": "KNOWN", "id": name, "version": "1.0.0",
                "digest": digest(LIMITS), "definition": LIMITS}

    return {"deviceId": state.config.device_id, "namespace": namespace(state.config.device_id),
            "serverInstanceId": state.server_id, "adapterConfigurationId": state.config.digest,
            "homeId": state.home_id, "profile": {"definition": profile, "digest": digest(profile)},
            "adapter": component("fleet_reference"),
            "runtime": {"status": "KNOWN", "manifestDigest": hashlib.sha256(raw).hexdigest(),
                        "rosDistro": manifest["rosDistribution"], "rmw": manifest["rmw"],
                        "python": manifest["python"], "architecture": manifest["architecture"]},
            "operatingPolicy": policy("reference-operation"),
            "safetyConfig": policy("reference-safety"),
            "ai": {"status": "NOT_APPLICABLE", "reason": "NOT_USED"}}
