import json
from pathlib import Path

from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus
from nav_msgs.msg import Odometry
import pytest
from sensor_msgs.msg import BatteryState, NavSatFix

from fleet_bridge.config import load_config
from fleet_bridge.journal import Journal
from fleet_bridge.observations import Observations, diagnostic_level


@pytest.fixture
def observer(tmp_path):
    clock = [100.0]
    config = load_config({"BRIDGE_DEVICE_ID": "observed", "BRIDGE_STATE_DIR": str(tmp_path)})
    return Observations(config, lambda: clock[0], lambda: clock[0]), clock, config


def stamped(message, sec=100):
    message.header.stamp.sec = sec
    return message


@pytest.mark.parametrize("value,expected", [
    (0.0, 0), (0.8, 80), (float("nan"), None), (-0.1, None), (1.1, None),
])
def test_battery_units_and_missing(observer, value, expected):
    observations, clock, config = observer
    assert observations.snapshot() is None
    battery = stamped(BatteryState(percentage=value, temperature=float("nan"), present=True))
    observations.receive("battery", battery)
    result = observations.snapshot()
    assert result["battery"] == pytest.approx(expected) if expected is not None else (
        result["battery"] is None)
    assert result["temperature"] is None
    assert result["position"] is None
    assert result["flightStatus"] == "UNKNOWN"
    clock[0] += 3
    result = observations.snapshot()
    assert result["battery"] is None and result["quality"]["battery"]["reason"] == "STALE"


def test_frame_units_and_negative_local_altitude(observer):
    observations, clock, config = observer
    message = stamped(Odometry())
    message.header.frame_id = config.namespace[1:] + "/map"
    message.child_frame_id = config.namespace[1:] + "/base_link"
    message.pose.pose.position.z = -2.0
    message.twist.twist.linear.x = 0.25
    observations.receive("odometry", message)
    result = observations.snapshot()["position"]
    assert result["kind"] == "LOCAL" and result["pose"]["z"] == -2
    assert result["velocity"]["frameId"] == message.child_frame_id
    clock[0] += 1
    message.header.stamp.sec += 1
    message.header.frame_id = "wrong-frame"
    observations.receive("odometry", message)
    result = observations.snapshot()
    assert result["position"] is None
    assert result["quality"]["position"]["reason"] == "FRAME_MISMATCH"


def test_ros_clock_reset_and_no_repeated_freshness(observer):
    observations, clock, config = observer
    message = stamped(BatteryState(percentage=0.8, present=True))
    observations.receive("battery", message)
    assert observations.snapshot()["battery"] == pytest.approx(80)
    clock[0] += 1
    message.header.stamp.sec = 99
    observations.receive("battery", message)
    result = observations.snapshot()
    assert result["battery"] is None
    assert result["quality"]["battery"]["reason"] == "CLOCK_RESET"
    clock[0] += 1
    message.header.stamp.sec = 100
    observations.receive("battery", message)
    assert observations.snapshot()["battery"] == pytest.approx(80)
    clock[0] += 3
    observations.receive("battery", message)
    assert observations.snapshot()["quality"]["battery"]["reason"] == "STALE"
    clock[0] += 1
    message.header.stamp.sec = 0
    observations.receive("battery", message)
    assert observations.snapshot()["battery"] is None


def test_diagnostic_bounding_qos_and_freshness(observer):
    assert diagnostic_level(b"\x02") == "ERROR"
    observations, clock, config = observer
    message = stamped(DiagnosticArray(status=[DiagnosticStatus(
        name="component", hardware_id="observed", level=2, message="secret-not-forwarded")] * 40))
    observations.receive("diagnostics", message)
    result = observations.snapshot()
    assert len(result["diagnostics"]) == 32 and result["diagnosticsTruncated"]
    assert "secret" not in json.dumps(result)
    clock[0] += 1
    observations.incompatible("diagnostics")
    result = observations.snapshot()
    assert result["diagnostics"] == []
    assert result["quality"]["diagnostics"]["reason"] == "QOS_INCOMPATIBLE"


def test_fix_no_fix_and_unknown_altitude(observer):
    observations, clock, config = observer
    message = stamped(NavSatFix(latitude=35.0, longitude=139.0, altitude=float("nan")))
    message.status.status = 0
    observations.receive("fix", message)
    result = observations.snapshot()["position"]
    assert result["kind"] == "GEODETIC" and result["altitude"] is None
    clock[0] += 1
    message.header.stamp.sec += 1
    message.status.status = -1
    observations.receive("fix", message)
    assert observations.snapshot()["position"] is None


def test_durable_until_scoped_db_receipt_and_restart(observer):
    observations, clock, config = observer
    observations.receive("battery", stamped(BatteryState(percentage=0.0, present=True)))
    journal = Journal(config)
    journal.observation(observations.snapshot())
    original = journal.pending_observations()[0][1]
    message = json.loads(original)
    journal.close()
    journal = Journal(config)
    assert journal.session != message["sessionId"]
    assert journal.pending_observations()[0][1] == original
    receipt = {"schemaVersion": 1, "deviceId": config.device_id,
               "sessionId": message["sessionId"], "sequence": message["sequence"],
               "timestamp": message["timestamp"], "status": "STORED"}
    journal.receive(f"fleet/v1/devices/{config.device_id}/telemetry-receipts",
                    json.dumps({**receipt, "deviceId": "other"}).encode())
    assert journal.pending_observations()
    journal.receive(f"fleet/v1/devices/{config.device_id}/telemetry-receipts",
                    json.dumps(receipt).encode())
    assert journal.pending_observations() == []
    journal.close()


def test_wire_fixture_parity(observer):
    import fastjsonschema
    observations, clock, config = observer
    root = Path("/workspace/contracts")
    validate = fastjsonschema.compile(json.loads(
        (root / "ros-observation.schema.json").read_text()))
    for case in json.loads((root / "observation-fixtures.json").read_text()):
        if case["valid"]:
            validate(case["message"])
        else:
            with pytest.raises(fastjsonschema.JsonSchemaException):
                validate(case["message"])


def test_sim_clock_is_not_utc_and_system_backlog_is_stale(observer):
    observations, clock, config = observer
    message = stamped(BatteryState(percentage=0.8, present=True), 10)
    observations.receive("battery", message)
    assert observations.snapshot()["quality"]["battery"]["reason"] == "STALE"
    clock[0] += 1
    message.header.stamp.sec = 11
    observations.receive("battery", message, sim_time=True)
    clock[0] += 1
    message.header.stamp.sec = 12
    observations.receive("battery", message, sim_time=True)
    result = observations.snapshot()
    assert result["quality"]["battery"]["timeDomain"] == "ROS"
    assert result["battery"] == pytest.approx(80)
    clock[0] += 1
    message.header.stamp.sec = 10000
    observations.receive("battery", message, sim_time=True)
    assert observations.snapshot()["battery"] is None


def test_real_dds_incompatible_qos_and_publisher_stop(tmp_path):
    import time
    from rclpy.node import Node
    from rclpy.duration import Duration
    from rclpy.qos import QoSProfile, ReliabilityPolicy
    from fleet_bridge.ros_client import RosClient

    config = load_config({"BRIDGE_DEVICE_ID": "qos-test", "BRIDGE_STATE_DIR": str(tmp_path)})
    bridge = RosClient(config)
    publisher = Node("qos_test", namespace=config.namespace)
    try:
        qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                         deadline=Duration(seconds=2))
        diagnostics = publisher.create_publisher(DiagnosticArray, "diagnostics", qos)
        battery = publisher.create_publisher(BatteryState, "battery", qos)
        end = time.monotonic() + 8
        while time.monotonic() < end:
            message = BatteryState(percentage=0.8, present=True)
            message.header.stamp = publisher.get_clock().now().to_msg()
            battery.publish(message)
            diagnostics.publish(DiagnosticArray())
            state = bridge.observations.health()
            if ("diagnostics" in state["observation_qos_incompatible"]
                    and state["observation_quality"]["battery"] == "VALID"):
                break
            time.sleep(0.05)
        else:
            pytest.fail("DDS QoS event or battery observation was not received")
        publisher.destroy_publisher(battery)
        time.sleep(3.1)
        state = bridge.observations.health()
        assert state["observation_quality"]["battery"] == "STALE"
        assert "diagnostics" in state["observation_qos_incompatible"]
    finally:
        publisher.destroy_node()
        bridge.close()


def test_telemetry_eviction_records_loss_without_deleting_inbox(observer):
    from dataclasses import replace
    observations, clock, config = observer
    observations.receive("battery", stamped(BatteryState(percentage=0.0, present=True)))
    payload = observations.snapshot()
    journal = Journal(replace(config, record_limit=2))
    journal.receive(f"fleet/v1/devices/{config.device_id}/commands", b"preserve")
    for _ in range(3):
        journal.observation(payload)
    rows = journal.pending_observations()
    assert [json.loads(body)["sequence"] for _, body in rows] == [1, 2]
    assert journal.db.execute("SELECT count FROM telemetry_loss").fetchone()[0] == 1
    assert journal.db.execute("SELECT body FROM inbox").fetchone()[0] == b"preserve"
    journal.close()
