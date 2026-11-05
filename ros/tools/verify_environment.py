"""固定OCI内の全debを照合する。依存解決やネットワーク取得は行わない。"""

import hashlib
from importlib.metadata import version
import json
import pathlib
import platform
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
arch = {"aarch64": "arm64", "x86_64": "amd64"}[platform.machine()]
expected = (root / "locks" / f"dpkg-{arch}.tsv").read_bytes()
actual = subprocess.check_output(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\n"])
if actual != expected:
    raise SystemExit("Installed package versions differ from the committed lock")
if platform.python_version_tuple()[:2] != ("3", "12"):
    raise SystemExit("Python 3.12 is required")
manifest = json.loads((root / "locks/environment.json").read_text())
for dependency in manifest["additionalPythonDependencies"]:
    name, expected_version = dependency.split("==")
    if version(name) != expected_version:
        raise SystemExit("Python dependency version differs from lock")
manifest.update(architecture=arch, python=platform.python_version(),
                packagesSha256=hashlib.sha256(actual).hexdigest())
source = hashlib.sha256()
paths = [path for directory in ("src", "contracts", "locks")
         for path in (root / directory).rglob("*")]
for path in sorted(paths):
    if path.is_file():
        source.update(str(path.relative_to(root)).encode() + b"\0" + path.read_bytes())
manifest["sourceSha256"] = source.hexdigest()
(root / "environment-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest))
