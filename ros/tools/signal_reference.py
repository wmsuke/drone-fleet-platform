"""専用container内の参照子processか試験supervisorだけへ障害を注入する。"""

from pathlib import Path
import os
import signal
import sys

name = sys.argv[1]
assert name in ("SIGHUP", "SIGSTOP", "SIGCONT")
pids = []
for path in Path("/proc").glob("[0-9]*/cmdline"):
    try:
        args = path.read_bytes().split(bytes([0]))
    except (FileNotFoundError, ProcessLookupError):
        continue
    target = (any(a.endswith(b"/reference_supervisor.py") for a in args) if name == "SIGHUP"
              else b"fleet_reference.cli" in args)
    if target:
        pids.append(int(path.parent.name))
assert len(pids) == 1, pids
os.kill(pids[0], getattr(signal, name))
