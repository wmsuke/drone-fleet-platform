"""SQLite owner threadでAction状態を進める。ROS待ち・MQTT接続と原子性を偽らない。"""

import base64
from datetime import datetime, timezone
import hashlib
import json
import math
import time
import uuid

from rclpy.serialization import serialize_message

from .command_journal import instant
from fleet_reference.configuration import digest


def stamp(value):
    return datetime.fromtimestamp(value.sec + value.nanosec / 1e9, timezone.utc).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")


def goal_id(value):
    return str(uuid.UUID(bytes=bytes(value.uuid)))


class Execution:
    def __init__(self, commands, ros):
        self.commands, self.ros = commands, ros
        self.owner = commands.db.execute("SELECT journal FROM bridge_counters").fetchone()[0]
        self.commands.recovery()
        self.sends = {}
        self.rejections = {}
        self.results = {}
        self.queries = {}
        self.unknowns = {}
        self.next_query = {}
        self.next_feedback = {}
        self.stop_since = {}
        self.last_runtime = time.monotonic()
        self.owns = False

    def fault(self, point, command_id):
        config = self.commands.journal.config
        if (config.test_fault == point
                and (not config.test_fault_command or config.test_fault_command == command_id)):
            with (config.state_dir / "fault.json").open("w") as output:
                json.dump({"point": point, "commandId": command_id}, output)
            # 明示した試験modeのみ。heartbeat permissionも1.5秒で失効する。
            while True:
                time.sleep(0.1)

    def unresolved(self, value):
        progress = self.commands.progress(value["commandId"])
        return value["state"] != "REJECTED" and not progress["stopConfirmed"]

    def heartbeat(self, runtime, values):
        permitted = False
        if runtime:
            active = goal_id(runtime.active_goal_id) if runtime.has_active_goal else None
            last = (goal_id(runtime.last_terminal_goal_id)
                    if runtime.has_last_terminal_goal else None)
            matching = {v["goalId"]: v for v in values if
                        v["configuration"]["serverInstanceId"] == runtime.server_instance_id
                        and v["configuration"]["adapterConfigurationId"]
                        == runtime.configuration_id}
            unresolved = [v for v in values if self.unresolved(v) and v["state"] != "READY"]
            if unresolved:
                matching = {key: v for key, v in matching.items() if v in unresolved}
            if active:
                permitted = active in matching
            elif last:
                permitted = last in matching
            else:
                permitted = not unresolved
        self.owns = permitted
        self.ros.permit_heartbeat(self.owner, runtime if permitted else None)

    def ready(self, runtime, configuration):
        sample = self.ros.observations.execution_sample()
        return (self.owns and runtime is not None and runtime.ready and not runtime.has_active_goal
                and configuration is not None and sample is not None and sample["battery"] >= 20
                and sample["position"]["kind"] == "LOCAL")

    def uncertain(self, value, reason, raw=None):
        command_id = value["commandId"]
        self.unknowns.pop(command_id, None)
        progress = self.commands.progress(command_id)
        if progress["terminalEvent"]:
            return
        pending = self.queries.pop(command_id, None)
        if pending:
            self.ros.abandon_query(pending[0])
        pending = self.results.pop(command_id, None)
        if pending:
            pending.cancel()
        fields = {"status": "UNCERTAIN", "reason": reason}
        if raw is not None:
            fields["rawResult"] = {"hash": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
            if len(raw) <= 6144:
                fields["rawResult"]["cdr"] = base64.b64encode(raw).decode()
        if value["result"] and value["result"].get("startedAt"):
            fields["startedAt"] = value["result"]["startedAt"]
        self.commands.event(command_id, "EXECUTION", fields, "UNCERTAIN")

    def begin_recovery(self, command_id):
        with self.commands.db:
            self.commands.db.execute("UPDATE action_commands SET state='UNCERTAIN' WHERE command=?",
                                     (command_id,))
        pending = self.results.pop(command_id, None)
        if pending:
            pending.cancel()  # GetResult待ちを破棄するだけでgoalはcancelしない。

    def process_result(self, value, response):
        result = response.result
        config = value["configuration"]
        raw = bytes(serialize_message(result))
        try:
            frame = config["namespace"][1:] + "/map"
            started_at = stamp(result.started_at) if result.started else None
            finished_at = stamp(result.finished_at)
            numeric = [result.home_distance_m, result.stable_duration_s,
                       *[getattr(result.final_pose.pose.position, a) for a in ("x", "y", "z")],
                       *[getattr(result.final_velocity.twist.linear, a) for a in ("x", "y", "z")]]
            if (response.status not in (4, 5, 6) or goal_id(result.goal_id) != value["goalId"]
                    or result.server_instance_id != config["serverInstanceId"]
                    or result.configuration_id != config["adapterConfigurationId"]
                    or result.final_pose.header.frame_id != frame
                    or result.final_velocity.header.frame_id != frame
                    or not all(math.isfinite(n) and abs(n) <= 1e9 for n in numeric)
                    or result.home_distance_m < 0 or result.stable_duration_s < 0
                    or abs(instant(finished_at)
                           - instant(stamp(result.final_pose.header.stamp))) >= 3
                    or abs(instant(finished_at)
                           - instant(stamp(result.final_velocity.header.stamp))) >= 3
                    or instant(finished_at) < instant(value["command"]["timestamp"])
                    or (started_at and (instant(started_at) < instant(value["command"]["timestamp"])
                                        or instant(started_at) >= instant(
                                            value["command"]["expiresAt"])
                                        or instant(finished_at) < instant(started_at)))):
                raise ValueError()
            speed = math.sqrt(sum(getattr(result.final_velocity.twist.linear, a)**2
                                  for a in ("x", "y", "z")))
            state = {4: "SUCCEEDED", 5: "CANCELLED", 6: "FAILED"}[response.status]
            if not result.started:
                if response.status != 6:
                    raise ValueError()
                state = "REJECTED"
            if response.status == 4 and (result.reason != "HOME_REACHED" or not result.started
                                         or result.home_distance_m > 0.2 or speed > 0.05
                                         or result.stable_duration_s < 1):
                raise ValueError()
            if (time.time() >= instant(value["command"]["resultDeadline"])
                    or instant(finished_at) >= instant(value["command"]["resultDeadline"])
                    or result.reason == "RESULT_DEADLINE"):
                self.uncertain(value, "RESULT_DEADLINE", raw)
                return
            evidence = {"cdr": base64.b64encode(raw).decode(),
                        "hash": hashlib.sha256(raw).hexdigest(), "rosStatus": response.status,
                        "started": result.started, "startedAt": started_at,
                        "finishedAt": finished_at,
                        "poseFrame": frame, "velocityFrame": frame, "homeId": config["homeId"],
                        "poseMm": {a: round(getattr(result.final_pose.pose.position, a) * 1000)
                                   for a in ("x", "y", "z")},
                        "velocityMmPerSecond": {
                            a: round(getattr(result.final_velocity.twist.linear, a) * 1000)
                            for a in ("x", "y", "z")},
                        "homeDistanceMm": math.ceil(result.home_distance_m * 1000),
                        "speedMmPerSecond": math.ceil(speed * 1000),
                        "stableDurationMs": math.floor(result.stable_duration_s * 1000)}
            allowed = {"HOME_REACHED", "INJECTED_FAILURE", "BRIDGE_WATCHDOG", "SENSOR_STALE",
                       "LOW_BATTERY", "POLICY_REJECTED", "REJECTED_EXPIRED", "CANCELLED",
                       "SERVER_SHUTDOWN", "GOAL_ID_MISMATCH"}
            if result.reason not in allowed:
                raise ValueError()
        except (ValueError, OverflowError, AttributeError):
            self.uncertain(value, "RESULT_INVALID", raw)
            return
        fields = {"timestamp": finished_at, "status": state, "reason": result.reason,
                  "result": evidence}
        if started_at:
            fields["startedAt"] = started_at
        self.commands.event(value["commandId"], "EXECUTION", fields, state)
        self.fault("AFTER_RESULT", value["commandId"])

    def reconcile(self, value, runtime):
        command_id = value["commandId"]
        progress = self.commands.progress(command_id)
        if progress["terminalEvent"]:
            return
        now, mono = time.time(), time.monotonic()
        if now >= instant(value["command"]["resultDeadline"]):
            self.uncertain(value, "RESULT_DEADLINE")
            return
        if runtime and runtime.server_instance_id != value["configuration"]["serverInstanceId"]:
            self.uncertain(value, "SERVER_CHANGED")
            return
        elapsed = now - progress["queryStarted"] if progress["queryStarted"] is not None else 0
        if runtime is None:
            # 起動直後/通信断の未確認serverへUUID照会を出さない。既存予算は延長しない。
            if (elapsed >= 30 or elapsed < -5
                    or (progress["queryCount"] >= 5 and command_id not in self.queries)):
                self.uncertain(value, "RESULT_TIMEOUT")
            return
        if runtime.configuration_id != value["configuration"]["adapterConfigurationId"]:
            self.uncertain(value, "CONFIGURATION_MISMATCH")
            return
        unknown = self.unknowns.get(command_id)
        if unknown:
            # UNKNOWNにはserver UUIDがない。応答後の新しいruntime照会で世代を再確認する。
            serial, reason = unknown
            if self.ros.runtime_probe_serial() > serial:
                self.uncertain(value, reason)
            elif elapsed >= 30 or elapsed < -5:
                self.uncertain(value, "RESULT_TIMEOUT")
            return
        cache_window_elapsed = now - (progress["sendAt"] or instant(
            value["command"]["timestamp"])) >= (
                value["configuration"]["profile"]["definition"]["resultCacheMs"] / 1000)
        pending = self.queries.get(command_id)
        if pending:
            future, due = pending
            if future.done():
                del self.queries[command_id]
                try:
                    response = future.result()
                except Exception:
                    self.next_query[command_id] = mono + min(2**progress["queryCount"], 8)
                    return
                if response.status == 0:
                    self.unknowns[command_id] = (
                        self.ros.runtime_probe_serial(),
                        "RESULT_CACHE_UNAVAILABLE" if cache_window_elapsed else "RESULT_UNKNOWN")
                else:
                    self.process_result(value, response)  # SQLite例外を隠さない。
                return
            if mono < due:
                return
            self.ros.abandon_query(future)
            del self.queries[command_id]
            if cache_window_elapsed:
                self.uncertain(value, "RESULT_CACHE_UNAVAILABLE")
                return
            self.next_query[command_id] = mono + min(2**(progress["queryCount"] - 1), 8)
        exhausted = progress["queryCount"] >= 5
        if progress["queryStarted"] is not None:
            elapsed = now - progress["queryStarted"]
            exhausted = exhausted or elapsed >= 30 or elapsed < -5
        if exhausted:
            self.uncertain(value, "RESULT_TIMEOUT")
            return
        if mono >= self.next_query.get(command_id, 0):
            self.commands.query_attempt(command_id, now)  # 送る前に回数を永続化。
            self.queries[command_id] = (self.ros.query(value["goalId"]), mono + 2)

    def observe_stop(self, value, runtime):
        command_id = value["commandId"]
        progress = self.commands.progress(command_id)
        if (progress["stopConfirmed"] or not progress["terminalEvent"]
                or value["state"] not in ("SUCCEEDED", "FAILED", "CANCELLED")):
            return
        terminal = json.loads(progress["terminalEvent"])
        if time.time() - instant(terminal["timestamp"]) > 5:
            return
        sample = self.ros.observations.execution_sample()
        valid = (runtime and runtime.server_instance_id
                 == value["configuration"]["serverInstanceId"]
                 and runtime.configuration_id == value["configuration"]["adapterConfigurationId"]
                 and not runtime.has_active_goal and runtime.has_last_terminal_goal
                 and goal_id(runtime.last_terminal_goal_id) == value["goalId"]
                 and runtime.flight_status == "IDLE" and sample and sample["flightStatus"] == "IDLE"
                 and sample["position"]["kind"] == "LOCAL"
                 and sample["position"].get("velocity") is not None)
        if not valid:
            self.stop_since.pop(command_id, None)
            return
        linear = sample["position"]["velocity"]["linear"]
        speed = math.sqrt(sum(linear[a]**2 for a in ("x", "y", "z")))
        sampled = sample["positionReceivedAt"]
        if speed > 0.05 or instant(sampled) < instant(terminal["timestamp"]):
            self.stop_since.pop(command_id, None)
            return
        first, since = self.stop_since.setdefault(command_id, (sampled, time.monotonic()))
        if time.monotonic() - since >= 1 and instant(sampled) - instant(first) >= 1:
            self.commands.event(command_id, "STOP_OBSERVATION", {
                "reason": "STOP_OBSERVED", "terminalEventId": terminal["eventId"],
                "flightStatus": "IDLE", "speedMmPerSecond": math.ceil(speed * 1000),
                "dwellMs": math.floor((instant(sampled) - instant(first)) * 1000),
                "poseFrame": sample["position"]["frameId"],
                "firstSampleAt": first, "lastSampleAt": sampled})

    def tick(self, subscribed):
        runtime = self.ros.runtime_snapshot()
        reported = self.ros.configuration_snapshot()
        configuration = reported[1] if reported else None
        values = self.commands.open_commands()
        known = list(values)
        if runtime and runtime.has_last_terminal_goal:
            last = self.commands.by_goal(goal_id(runtime.last_terminal_goal_id))
            if last and last not in known:
                known.append(last)
        self.heartbeat(runtime, known)
        if runtime:
            self.last_runtime = time.monotonic()
        for value in values:
            command_id = value["commandId"]
            progress = self.commands.progress(command_id)
            if value["state"] == "READY":
                if time.time() >= instant(value["command"]["expiresAt"]):
                    self.commands.event(command_id, "EXECUTION", {
                        "status": "REJECTED", "reason": "REJECTED_EXPIRED"}, "REJECTED")
                elif (subscribed and self.ready(runtime, configuration)
                      and digest(configuration) == value["command"]["expectedConfigurationId"]
                      and time.time() >= instant(value["command"]["timestamp"])):
                    self.fault("BEFORE_SEND_INTENT", command_id)
                    value = self.commands.send_intent(command_id, time.time())
                    self.fault("AFTER_SEND_INTENT", command_id)
                    self.sends[command_id] = (self.ros.send(value, self.owner),
                                              time.monotonic() + 2)
                    self.fault("AFTER_SEND_GOAL", command_id)
            pending = self.sends.get(command_id)
            if pending:
                future, deadline = pending
                if future.done():
                    del self.sends[command_id]
                    try:
                        handle = future.result()
                    except Exception:
                        self.begin_recovery(command_id)
                        continue
                    if handle.accepted:
                        self.commands.event(command_id, "GOAL_ACCEPTED",
                                            {"reason": "GOAL_ACCEPTED"},
                                            "ACCEPTED")
                        self.results[command_id] = handle.get_result_async()
                    else:
                        self.rejections[command_id] = (
                            self.ros.rejection(value["goalId"]), time.monotonic() + 2)
                elif time.monotonic() >= deadline:
                    future.cancel()
                    del self.sends[command_id]
                    self.begin_recovery(command_id)
            rejection = self.rejections.get(command_id)
            if rejection and (rejection[0].done() or time.monotonic() >= rejection[1]):
                future, _ = self.rejections.pop(command_id)
                fields = {"reason": "ACTION_REJECTED"}
                try:
                    if not future.done():
                        self.ros.abandon_rejection(future)
                    else:
                        decision = future.result()
                        reasons = {"INVALID_GOAL", "OWNER_MISMATCH", "DEVICE_BUSY",
                                   "COMMAND_REPLAY_OR_FULL", "CONFIGURATION_MISMATCH",
                                   "REJECTED_EXPIRED", "INVALID_DEADLINE", "INJECTED_REJECT",
                                   "BRIDGE_WATCHDOG", "SENSOR_STALE", "LOW_BATTERY",
                                   "POLICY_REJECTED"}
                        if (decision.found and goal_id(decision.goal_id) == value["goalId"]
                                and decision.server_instance_id
                                == value["configuration"]["serverInstanceId"]
                                and decision.configuration_id
                                == value["configuration"]["adapterConfigurationId"]
                                and decision.reason in reasons):
                            raw = bytes(serialize_message(decision))
                            if len(raw) <= 6144:
                                fields["adapterDecision"] = {
                                    "reason": decision.reason,
                                    "cdr": base64.b64encode(raw).decode(),
                                    "hash": hashlib.sha256(raw).hexdigest()}
                except Exception:
                    pass  # 明示rejectは既知だが、理由を取得できなければ補完しない。
                self.commands.event(command_id, "GOAL_REJECTED", fields, "REJECTED")
            feedback = self.ros.latest_feedback(command_id)
            if feedback and time.monotonic() >= self.next_feedback.get(command_id, 0):
                if (goal_id(feedback.goal_id) == value["goalId"]
                        and feedback.server_instance_id
                        == value["configuration"]["serverInstanceId"]
                        and feedback.configuration_id
                        == value["configuration"]["adapterConfigurationId"]
                        and math.isfinite(feedback.distance_m) and feedback.distance_m >= 0):
                    started_at = stamp(feedback.started_at)
                    if value["state"] in ("SEND_INTENT", "ACCEPTED", "RUNNING"):
                        if value["state"] != "RUNNING":
                            self.commands.event(command_id, "EXECUTION", {
                                "status": "RUNNING", "reason": "EXECUTION_STARTED",
                                "startedAt": started_at}, "RUNNING")
                        self.commands.event(command_id, "FEEDBACK", {
                            "reason": "FEEDBACK", "startedAt": started_at,
                            "distanceMm": math.ceil(feedback.distance_m * 1000)})
                        self.next_feedback[command_id] = time.monotonic() + 1
            future = self.results.get(command_id)
            if future and future.done():
                del self.results[command_id]
                try:
                    response = future.result()
                except Exception:
                    self.begin_recovery(command_id)
                else:
                    self.process_result(self.commands.get(command_id), response)
            value = self.commands.get(command_id)
            if (self.unresolved(value) and not progress["terminalEvent"]
                    and value["state"] != "READY"):
                if (time.time() >= instant(value["command"]["resultDeadline"])
                        or (runtime and runtime.server_instance_id
                            != value["configuration"]["serverInstanceId"])):
                    self.begin_recovery(command_id)
                elif command_id in self.results and time.monotonic() - self.last_runtime >= 3:
                    self.begin_recovery(command_id)
                if value["state"] == "UNCERTAIN":
                    self.reconcile(value, runtime)
            self.observe_stop(self.commands.get(command_id), runtime)
        if (subscribed and self.ready(runtime, configuration)
                and not self.commands.open_commands()):
            for command in self.commands.received_commands():
                if (time.time() < instant(command["expiresAt"])
                        and digest(configuration) == command["expectedConfigurationId"]):
                    self.commands.prepare(command, configuration, time.time())
                    break
        return bool(subscribed and self.ready(runtime, configuration)
                    and not self.commands.open_commands())

    def close(self):
        self.ros.permit_heartbeat(self.owner, None)
        for future, _ in self.queries.values():
            self.ros.abandon_query(future)
        for future, _ in self.sends.values():
            future.cancel()
        for future, _ in self.rejections.values():
            self.ros.abandon_rejection(future)
        for future in self.results.values():
            future.cancel()
