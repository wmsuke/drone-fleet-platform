"""E2E専用。HUPで子serverを強制終了・再起動しnetwork namespaceを維持する。"""

import signal
import subprocess
import sys
import time

stopping = False
restarting = False


def stop(_number, _frame):
    global stopping
    stopping = True


def restart(_number, _frame):
    global restarting
    restarting = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGHUP, restart)
child = subprocess.Popen([sys.executable, "-m", "fleet_reference.cli", *sys.argv[1:]])
while child.poll() is None and not stopping:
    if restarting:
        child.kill()
        child.wait(timeout=5)
        print("REFERENCE_TEST_COLD_RESTART", flush=True)
        child = subprocess.Popen([sys.executable, "-m", "fleet_reference.cli", *sys.argv[1:]])
        restarting = False
    time.sleep(0.05)
if child.poll() is None:
    child.terminate()
    try:
        child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)
        sys.exit(1)
sys.exit(child.returncode)
