"""試験のUDP遮断がconnected socketにも効き、TCPやprocessを止めないことを検査する。"""

import os
import subprocess
import sys


def test_test_only_udp_blackhole_and_restore():
    script = """
from pathlib import Path
import socket
flag = Path('/data/fleet/dds-cutoff')
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.bind(('127.0.0.1', 0))
udp.connect(udp.getsockname())
udp.settimeout(.2)
try:
    flag.touch()
    udp.send(b'blocked')
    try:
        udp.recv(16)
        raise AssertionError('UDP not blocked')
    except TimeoutError:
        pass
    server = socket.socket()
    server.bind(('127.0.0.1', 0))
    server.listen(1)
    client = socket.socket()
    client.connect(server.getsockname())
    peer, _ = server.accept()
    client.send(b'TCP_OK')
    assert peer.recv(16) == b'TCP_OK'
finally:
    flag.unlink(missing_ok=True)
udp.send(b'restored')
assert udp.recv(16) == b'restored'
print('UDP_BLOCKED_TCP_OK_RESTORED')
"""
    env = {**os.environ, "BRIDGE_INTEGRATION": "true",
           "LD_PRELOAD": "/workspace/tools/dds_fault.so"}
    result = subprocess.run([sys.executable, "-c", script], env=env,
                            timeout=5, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "UDP_BLOCKED_TCP_OK_RESTORED" in result.stdout
    assert "DDS_TEST_UDP_DROPPED" in result.stderr
