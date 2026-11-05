# 固定Python依存

BridgeのMQTT transportにPaho 2.1.0、Zodから生成したJSON Schemaの検証にfastjsonschema 2.21.2を使う。いずれもPyPI公式配布のpure Python wheelで、追加の実行時依存を持たない。hashは`../locks/wheels.sha256`で固定する。

- [paho-mqtt 2.1.0](https://pypi.org/project/paho-mqtt/2.1.0/): EPL-2.0 / EDL-1.0。配布元は`https://files.pythonhosted.org/packages/c4/cb/00451c3cf31790287768bb12c6bec834f5d292eaf3022afc88e14b8afc94/paho_mqtt-2.1.0-py3-none-any.whl`。
- [fastjsonschema 2.21.2](https://pypi.org/project/fastjsonschema/2.21.2/): BSD-3-Clause。配布元は`https://files.pythonhosted.org/packages/cb/a8/20d0723294217e47de6d9e2e40fd4a9d2f7c4b6ef974babd482a59743694/fastjsonschema-2.21.2-py3-none-any.whl`。

LICENSEと配布metadataは各wheel内に含む。固定OCIにpipがないため、hash照合後にPython標準のzipfileで`/opt/bridge-python`へ展開してimportする。packageのbuild scriptや依存解決、ネットワーク取得はbuild中に実行しない。更新時は両CPUでの実ROS/MQTT試験と共通fixtureの一致を確認する。
