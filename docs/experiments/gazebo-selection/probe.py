"""Issue #220の構成選定用。TaskやFleet Bridgeの実装ではない。"""

import json
import math
import os
import signal
import subprocess
import time
from pathlib import Path

from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
import rclpy
from rclpy.qos import qos_profile_sensor_data
from rosgraph_msgs.msg import Clock


root = Path('/tmp/flight-probe')
os.environ['GZ_PARTITION'] = 'issue220-selection'
os.environ['GZ_SIM_RESOURCE_PATH'] = str(root)
os.environ['ROS_DOMAIN_ID'] = '43'
os.environ['ROS_AUTOMATIC_DISCOVERY_RANGE'] = 'LOCALHOST'
os.environ['ROS_STATIC_PEERS'] = ''
processes = []
logs = []
samples = []
clocks = []
result = {'status': 'FAILED', 'scope': 'selection-only'}
node = None


def launch(name, args):
    log = (root / (name + '.log')).open('w')
    logs.append(log)
    process = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
    processes.append(process)
    return process


def odometry(message):
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
    launch('gazebo', ['gz', 'sim', '-s', '-r', '-v', '3', str(root / 'probe.sdf')])
    launch('bridge', [
        'ros2', 'run', 'ros_gz_bridge', 'parameter_bridge',
        '/model/x3/odometry@nav_msgs/msg/Odometry[gz.msgs.Odometry',
        '/clock@rosgraph_msgs/msg/Clock[gz.msgs.Clock',
        '/X3/gazebo/command/twist@geometry_msgs/msg/Twist]gz.msgs.Twist',
    ])
    rclpy.init()
    node = rclpy.create_node('issue220_selection_probe')
    node.create_subscription(Odometry, '/model/x3/odometry', odometry,
                             qos_profile_sensor_data)
    node.create_subscription(Clock, '/clock', lambda m: clocks.append(
        m.clock.sec + m.clock.nanosec / 1e9), qos_profile_sensor_data)
    publisher = node.create_publisher(Twist, '/X3/gazebo/command/twist', 10)
    deadline = time.monotonic() + 30
    while (not samples or not clocks or publisher.get_subscription_count() == 0):
        if time.monotonic() >= deadline:
            raise TimeoutError('ROS odometry/clock/command discovery')
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
    for log in logs:
        log.close()
    if node is not None:
        node.destroy_node()
    if rclpy.ok():
        rclpy.shutdown()
    (root / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    (root / 'odometry.json').write_text(json.dumps(samples, indent=2) + '\n')
    print(json.dumps(result, indent=2))
