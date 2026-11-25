"""閉じたGazebo環境でROS経由の飛行と起動期限を検証する。"""

import argparse
import hashlib
import json
import math
import os
import signal
import subprocess
import time
import uuid
from pathlib import Path

from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from observations import fleet_namespace, normalize_odometry, publisher as fleet_publisher
import rclpy
from rclpy.qos import qos_profile_sensor_data
from rosgraph_msgs.msg import Clock


root = Path('/tmp/flight-probe')
parser = argparse.ArgumentParser()
parser.add_argument('--expect-ready-timeout', action='store_true')
parser.add_argument('--fleet-device')
args = parser.parse_args()
fleet_frame = fleet_namespace(args.fleet_device) if args.fleet_device else None
fleet_output = None
output = Path('/tmp/flight-results')
output.mkdir()
run_id = str(uuid.uuid4())
os.environ['GZ_PARTITION'] = run_id
os.environ['GZ_SIM_RESOURCE_PATH'] = str(root)
os.environ['ROS_DOMAIN_ID'] = '43'
os.environ['ROS_AUTOMATIC_DISCOVERY_RANGE'] = 'LOCALHOST'
os.environ['ROS_STATIC_PEERS'] = ''
processes = []
logs = []
samples = []
clocks = []
result = {
    'status': 'FAILED', 'worldInstanceId': run_id, 'clockEpoch': 0,
    'scenario': 'missing-odometry' if args.expect_ready_timeout else 'ascent-hover',
    'packagesSha256': hashlib.sha256(Path('/opt/flight/packages.tsv').read_bytes()).hexdigest(),
    'worldSha256': hashlib.sha256((root / 'probe.sdf').read_bytes()).hexdigest(),
    'seed': 42, 'world': 'multicopter', 'spawnPositionM': [0, 0, 1],
    'nominalHomeM': [0, 0, 1], 'physicsStepS': 0.001,
}
node = None


def launch(name, args):
    log = (output / (name + '.log')).open('w')
    logs.append(log)
    process = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
    processes.append(process)
    return process


def odometry(message):
    if fleet_output is not None:
        observation = normalize_odometry(message, fleet_frame)
        if observation is not None:
            fleet_output.publish(observation)
    p, v = message.pose.pose.position, message.twist.twist.linear
    samples.append({'receivedMonotonic': time.monotonic(),
                    'stamp': message.header.stamp.sec + message.header.stamp.nanosec / 1e9,
                    'frame': message.header.frame_id,
                    'childFrame': message.child_frame_id,
                    'position': [p.x, p.y, p.z],
                    'speed': math.sqrt(v.x**2 + v.y**2 + v.z**2)})


def spin(seconds, command=None):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if any(p.poll() is not None for p in processes):
            raise RuntimeError('simulation or bridge exited')
        if command is not None:
            publisher.publish(command)
        rclpy.spin_once(node, timeout_sec=0.05)


def spin_sim(seconds, command):
    start = clocks[-1]
    deadline = time.monotonic() + 30
    while clocks[-1] - start < seconds:
        if time.monotonic() >= deadline:
            raise TimeoutError('simulation clock progression')
        spin(0.1, command)


try:
    launch('gazebo', ['gz', 'sim', '-s', '-r', '-v', '3', '--seed', '42', str(root / 'probe.sdf')])
    launch('bridge', [
        'ros2', 'run', 'ros_gz_bridge', 'parameter_bridge',
        '/model/x3/odometry@nav_msgs/msg/Odometry[gz.msgs.Odometry',
        '/clock@rosgraph_msgs/msg/Clock[gz.msgs.Clock',
        '/X3/gazebo/command/twist@geometry_msgs/msg/Twist]gz.msgs.Twist',
    ])
    rclpy.init()
    node = rclpy.create_node('flight_sim_smoke')
    if fleet_frame is not None:
        fleet_output = fleet_publisher(node, fleet_frame)

    odom_topic = '/missing/odometry' if args.expect_ready_timeout else '/model/x3/odometry'
    node.create_subscription(Odometry, odom_topic, odometry,
                             qos_profile_sensor_data)
    node.create_subscription(Clock, '/clock', lambda m: clocks.append(
        m.clock.sec + m.clock.nanosec / 1e9), qos_profile_sensor_data)
    publisher = node.create_publisher(Twist, '/X3/gazebo/command/twist', 10)
    deadline = time.monotonic() + (8 if args.expect_ready_timeout else 30)
    while (not samples or len(clocks) < 2 or clocks[-1] <= clocks[0]
           or not publisher.get_subscription_count()
           or (fleet_output is not None and not fleet_output.get_subscription_count())):
        if time.monotonic() >= deadline:
            raise TimeoutError('READY_TIMEOUT')
        spin(0.1)
    hover = Twist()
    spin_sim(3, hover)
    before = samples[-1]
    up = Twist()
    up.linear.z = 0.3
    spin_sim(3, up)
    spin_sim(4, hover)
    after = samples[-1]
    rise = after['position'][2] - before['position'][2]
    assert rise > 0.3, ('no physical ascent', rise)
    assert after['speed'] < 0.15, ('no settled hover', after)
    assert after['stamp'] > before['stamp'] > 0
    assert clocks[-1] > clocks[0]
    result.update(status='PASSED', before=before, after=after, riseM=rise,
                  odometrySamples=len(samples), clockSamples=len(clocks),
                  simTimeRange=[clocks[0], clocks[-1]])
except TimeoutError as error:
    result['reason'] = str(error)
    if (args.expect_ready_timeout and str(error) == 'READY_TIMEOUT'
            and len(clocks) >= 2 and clocks[-1] > clocks[0] and not samples
            and publisher.get_subscription_count()):
        result['status'] = 'EXPECTED_TIMEOUT'
    else:
        raise
except Exception as error:
    result['reason'] = str(error)
    raise
finally:
    exits = []
    for process in reversed(processes):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGINT)
        try:
            exits.append(process.wait(timeout=10))
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            exits.append(process.wait(timeout=5))
            result['status'] = 'FAILED'
    result['childExitCodes'] = exits
    if any(code != 0 for code in exits):
        result['status'] = 'FAILED'
    for log in logs:
        log.close()
    if node is not None:
        node.destroy_node()
    if rclpy.ok():
        rclpy.shutdown()
    (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    (output / 'odometry.json').write_text(json.dumps(samples, indent=2) + '\n')
    print(json.dumps(result, indent=2))

if result['status'] != ('EXPECTED_TIMEOUT' if args.expect_ready_timeout else 'PASSED'):
    raise SystemExit(1)
