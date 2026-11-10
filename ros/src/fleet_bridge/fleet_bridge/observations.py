"""ROS観測を単位・frame・source時刻を保持してsnapshot化する。"""

from datetime import datetime, timezone
import math
import threading
import time


FIELDS = ("battery", "temperature", "position", "flightStatus", "diagnostics")


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def vector(value):
    result = {axis: float(getattr(value, axis)) for axis in ("x", "y", "z")}
    return result if all(math.isfinite(v) for v in result.values()) else None


def bounded(value):
    return value.encode("utf8")[:256].decode("utf8", errors="ignore")


def diagnostic_level(value):
    # DiagnosticStatus.levelはIDL byte。JazzyのDDS受信では1 byteのbytesになる。
    if isinstance(value, bytes):
        value = value[0] if len(value) == 1 else -1
    return ("OK", "WARN", "ERROR", "STALE")[value] if (
        isinstance(value, int) and 0 <= value < 4) else "STALE"


class Observations:
    def __init__(self, config, monotonic=time.monotonic, wall=time.time):
        self.config = config
        self.now = monotonic
        self.wall = wall
        self.guard = threading.Lock()
        self.samples = {}
        self.stamps = {}
        self.epoch = 0
        self.revision = 0
        self.last_signature = None
        self.next_snapshot = 0
        self.seen = False
        self.truncated = False
        self.domain = "SYSTEM"
        self.qos_errors = set()

    def incompatible(self, topic):
        with self.guard:
            self.qos_errors.add(topic)
            self.revision += 1

    def receive(self, topic, message, sim_time=False):
        with self.guard:
            domain = "ROS" if sim_time else "SYSTEM"
            stamp = message.header.stamp
            ns = stamp.sec * 1_000_000_000 + stamp.nanosec
            if not 0 <= stamp.nanosec < 1_000_000_000:
                ns = 0  # builtin Timeのuint32範囲だけでは有効なstampにならない。
            now = self.now()
            previous = self.stamps.get(topic)
            reset = (domain != self.domain or ns <= 0
                     or (previous and (ns < previous[0]
                         or abs((ns - previous[0]) / 1e9 - (now - previous[1])) > 30)))
            self.domain = domain
            if reset:
                self.epoch += 1
                self.samples.clear()
                self.stamps.clear()
                self.revision += 1
                if ns > 0:
                    self.stamps[topic] = (ns, now)
                return  # resetを起こした値自体をfreshにしない
            if previous and ns == previous[0]:
                return  # 同じsourceをfresh sampleへ水増ししない
            self.stamps[topic] = (ns, now)
            self.seen = True
            self.qos_errors.discard(topic)
            quality = {"reason": "VALID", "stamp": {"sec": stamp.sec, "nanosec": stamp.nanosec},
                       "timeDomain": domain, "clockEpoch": self.epoch, "receivedAt": utc()}

            def save(field, value, reason="VALID"):
                if domain == "SYSTEM" and abs(self.wall() - ns / 1e9) >= 3:
                    reason = "STALE"
                    value = ("UNKNOWN" if field == "flightStatus"
                             else [] if field == "diagnostics" else None)
                self.samples[field] = (value, {**quality, "reason": reason}, now, topic)

            if topic == "battery":
                valid = message.present and math.isfinite(message.percentage) and (
                    0 <= message.percentage <= 1)
                save("battery", message.percentage * 100 if valid else None,
                     "VALID" if valid else "INVALID")
                valid = message.present and math.isfinite(message.temperature)
                save("temperature", message.temperature if valid else None,
                     "VALID" if valid else "INVALID")
            elif topic == "odometry":
                frame = self.config.namespace[1:]
                pose = vector(message.pose.pose.position)
                linear = vector(message.twist.twist.linear)
                angular = vector(message.twist.twist.angular)
                if (message.header.frame_id != frame + "/map"
                        or message.child_frame_id != frame + "/base_link"):
                    save("position", None, "FRAME_MISMATCH")
                elif pose is None:
                    save("position", None, "INVALID")
                else:
                    velocity = ({"frameId": message.child_frame_id, "linear": linear,
                                 "angular": angular, "linearUnit": "m/s", "angularUnit": "rad/s"}
                                if linear is not None and angular is not None else None)
                    save("position", {"kind": "LOCAL", "frameId": message.header.frame_id,
                                      "convention": "ENU", "unit": "m", "pose": pose,
                                      "velocity": velocity})
            elif topic == "fix":
                valid = (0 <= message.status.status <= 2 and math.isfinite(message.latitude)
                         and math.isfinite(message.longitude) and -90 <= message.latitude <= 90
                         and -180 <= message.longitude <= 180)
                save("position", {"kind": "GEODETIC", "latitude": message.latitude,
                                  "longitude": message.longitude,
                                  "altitude": message.altitude if math.isfinite(
                                      message.altitude) else None,
                                  "altitudeReference": "WGS84_ELLIPSOID", "unit": "m"}
                     if valid else None, "VALID" if valid else "INVALID")
            elif topic == "diagnostics":
                # 自由message/valuesは転送しない。識別子とlevelだけのallowlist。
                self.truncated = len(message.status) > 32 or any(
                    len(s.name.encode()) > 256 or len(s.hardware_id.encode()) > 256
                    for s in message.status[:32])
                save("diagnostics", [{"name": bounded(s.name) or "unnamed",
                                      "hardwareId": bounded(s.hardware_id),
                                      "level": diagnostic_level(s.level)}
                                     for s in message.status[:32]])
            elif topic == "runtime_state":
                valid = (message.device_id == self.config.device_id
                         and message.header.frame_id == self.config.namespace[1:] + "/map"
                         and message.flight_status in ("IDLE", "FLYING", "RETURNING_HOME"))
                save("flightStatus", message.flight_status if valid else "UNKNOWN",
                     "VALID" if valid else "INVALID")
            self.revision += 1

    def snapshot(self):
        with self.guard:
            now = self.now()
            if not self.seen or now < self.next_snapshot:
                return None
            payload = {"source": "ROS2", "diagnosticsTruncated": self.truncated, "quality": {}}
            states = []
            topics = {"battery": "battery", "temperature": "battery", "position": "odometry",
                      "flightStatus": "runtime_state", "diagnostics": "diagnostics"}
            for field in FIELDS:
                default = ("UNKNOWN" if field == "flightStatus"
                           else [] if field == "diagnostics" else None)
                sample = self.samples.get(field)
                quality = {"reason": "CLOCK_RESET" if self.epoch else "MISSING", "stamp": None,
                           "timeDomain": self.domain, "clockEpoch": self.epoch, "receivedAt": None}
                value = default
                if sample:
                    value, quality, received, topic = sample
                    quality = dict(quality)
                    if now - received >= 3:
                        quality["reason"] = "STALE"
                        value = default
                else:
                    topic = topics[field]
                if topic in self.qos_errors:
                    quality["reason"] = "QOS_INCOMPATIBLE"
                    value = default
                payload[field] = value
                payload["quality"][field] = quality
                states.append(quality["reason"])
            signature = (self.revision, tuple(states))
            if signature == self.last_signature:
                return None
            self.last_signature = signature
            self.next_snapshot = now + 1  # 最大1 Hz。再送はこの制御とは独立。
            return payload

    def health(self):
        with self.guard:
            now = self.now()
            reasons = {}
            for field in FIELDS:
                sample = self.samples.get(field)
                reasons[field] = ("MISSING" if sample is None
                                  else "STALE" if now - sample[2] >= 3 else sample[1]["reason"])
            return {"observation_quality": reasons,
                    "observation_qos_incompatible": sorted(self.qos_errors),
                    "observation_clock_epoch": self.epoch}

    def execution_sample(self):
        with self.guard:
            now = self.now()
            values = {}
            for name in ("battery", "position", "flightStatus"):
                sample = self.samples.get(name)
                if not sample or sample[1]["reason"] != "VALID" or now - sample[2] >= 3:
                    return None
                values[name] = sample[0]
            values["positionReceivedAt"] = self.samples["position"][1]["receivedAt"]
            return values
