"""固定された公式資産を選定試験の一時領域へ取得する。製品buildでは使わない。"""

import hashlib
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


root = Path('/tmp/flight-probe')
root.mkdir(exist_ok=True)
assets = [
    ('upstream.sdf',
     'https://raw.githubusercontent.com/gazebosim/gz-sim/'
     'a7f89720bbcb1a5191e4eb53917fef048c26740c/'
     'examples/worlds/multicopter_velocity_control.sdf',
     '836751d49d0049171586c5dbc58a18ad7a37ef8a475de9a796b5b1ff8168547b'),
    ('x3.zip',
     'https://fuel.gazebosim.org/1.0/OpenRobotics/models/X3%20UAV/4/X3%20UAV.zip',
     'c995a307936ce7df5a544e6c89b0396d054befa6ff5fbdbf262949b59cc12247'),
]
for name, url, expected in assets:
    path = root / name
    if not path.exists():
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read(32 * 1024 * 1024 + 1)
        if len(content) > 32 * 1024 * 1024:
            raise ValueError('asset exceeds selection budget')
        path.write_bytes(content)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError('asset hash mismatch: ' + name)
with zipfile.ZipFile(root / 'x3.zip') as archive:
    archive.extractall(root / 'x3')
tree = ET.parse(root / 'upstream.sdf')
world = tree.getroot().find('world')
world.remove(world.findall('include')[1])  # 比較に不要なhexacopterを除く。
model = world.find('include')
model.find('uri').text = str(root / 'x3')
ET.SubElement(model, 'pose').text = '0 0 1 0 0 0'
world.remove(next(p for p in world.findall('plugin')
                  if p.get('name') == 'gz::sim::systems::Sensors'))
world.find('physics/max_step_size').text = '0.001'
tree.write(root / 'probe.sdf', encoding='unicode')
print('worldSha256=' + hashlib.sha256((root / 'probe.sdf').read_bytes()).hexdigest())
