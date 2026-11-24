# Gazebo構成選定の起動試験（#220）

[ADR 0009](../../adr/0009-flight-simulation-task-evaluation-and-recovery.md)の選定根拠。2026-11-24に既存の固定ROS baseから作った使い捨てLinux arm64 containerへ公式ROS debを追加し、Gazebo Harmonic 8.15.0 / ros_gz 1.0.25を試した。ホストのROS導入、`ros/Dockerfile`や`ros/locks`の変更、AWS利用は行っていない。

## 確認したこと

- 公式multicopter worldを固定revisionから取得し、X3 Fuel model revision 4のzip hashを検証した。hexacopterと描画sensor pluginを除き、1機・初期pose (0,0,1)m・1ms物理stepに限定した。Gazebo標準の速度制御と4 rotorの推力モデルを使用し、poseを外から書き換えて移動させていない。
- `gz sim -s -r`と`ros_gz_bridge`を別processで起動した。X/GUI/GPU公開は使っていない。Gazebo Transportのpartition、DDS localhost/domain 43とresource pathを明示した。
- ROSのTwistをbody frameのGazebo入力へ送り、OdometryとClockをROSで受信した。sim時間3秒hover準備→上向き0.3m/sを3秒→zero twistで4秒とし、各phaseには30秒wall上限を設けた。
- sim時計が前進し、上昇量0.3m超・最終速度0.15m/s未満となることを確認した。2 processともSIGINT終了コード0。これはTask評価基準の検証ではない。

最終版の実測は[result.json](result.json)、全deb一覧は[packages.arm64.tsv](packages.arm64.tsv)。sim時計基準に直す前のwall時間基準の試行も2回成功したが、最終版の2回と区別している。試行数を大規模な安定性実績には使わない。

| 観点     | 結果と限界                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実行環境 | macOS arm64 / Docker Linux aarch64 29.8.2。Dockerへ8 CPU / 約8 GiBを割当。ROS baseのindex digestはresultへ記録                                                                     |
| 資源     | 実行中の1点測定でcontainer CPU 80.69%、memory 137.6 MiB。peakや最低要件ではない。apt取得・cacheを含むBlock I/Oをメモリ使用と混同しない                                             |
| 時計     | 最終版でsim約10秒を進めて測定。sim時間とwall時間は一致しない。初期版でもreal-time factor低下を観測し、sim時間待ち＋wall上限へ修正した                                              |
| frame    | 元topicは`x3/odom` / `x3/base_footprint`。Fleetのmap/base_linkへの変換は未実装。名前を変えるだけで適合済みにしない                                                                 |
| 依存     | 試験時はaptで依存を取得したため既存baseのROS debも更新され得る。完全なsnapshot image/両CPU固定は#221で実施する                                                                     |
| 初回失敗 | meshの`model://x3`探索pathを渡さずworld読み込みが失敗。`GZ_SIM_RESOURCE_PATH=/tmp/flight-probe`を指定して解消。Gazeboが終了コード0でも、probeはprocess早期終了を失敗として検出した |
| cleanup  | 選定試験終了後、使い捨てcontainerを削除した。専用volume/network/imageは作成していない。共有ROS baseや他の作業の資産は削除しない                                                    |
| 未検証   | native amd64、Fleet MQTT/DB/API接続、RETURN_HOME Action、Task評価、battery消費、contact/障害物、reset/復旧、GUI・実機・実AWS。#221以降へ引き渡す                                   |

## 再実行

これは製品用起動コマンドやCIではなく、選定実験を追試する手順である。リポジトリrootからbashで実行する。Dockerとnetwork接続、依存取得用の空き領域が必要。aptの候補が変われば`packages.arm64.tsv`との差を確認し、同一構成の再現とは呼ばない。配布物が失われた場合もhash検証を外さない。

```bash
probe_container="issue220-flight-probe-$$"
probe_results="$(mktemp -d)"
trap 'docker rm -f "$probe_container" >/dev/null 2>&1 || true' EXIT
docker run --name "$probe_container" \
  --mount "type=bind,src=$PWD/docs/experiments/gazebo-selection,dst=/probe,readonly" \
  --entrypoint bash \
  ros@sha256:8eed0a4669bbf43ee331878a4c39bd8ebddea8e3312a58b4fae8edb14526b617 \
  -lc 'set -e; apt-get update; apt-get install -y --no-install-recommends ros-jazzy-ros-gz-sim ros-jazzy-ros-gz-bridge; source /opt/ros/jazzy/setup.bash; python3 /probe/prepare.py; dpkg-query -W > /tmp/flight-probe/packages.tsv; python3 /probe/probe.py'
docker cp "$probe_container:/tmp/flight-probe/." "$probe_results/"
docker rm "$probe_container"
trap - EXIT
printf '選定試験の結果: %s\n' "$probe_results"
```

失敗時も`docker cp`で`/tmp/flight-probe`を回収してからcontainerを削除する。`result.json`のstatus、childExitCodes、gazebo/bridge.logと元odometry.jsonを確認する。単なる起動ログやCLI終了コードだけで成功にしない。共有imageのprune・host設定変更は不要。

`prepare.py`は固定された公式資産を一時領域へ展開する。元worldは[Gazebo source](https://github.com/gazebosim/gz-sim/blob/a7f89720bbcb1a5191e4eb53917fef048c26740c/examples/worlds/multicopter_velocity_control.sdf)、modelは[Fuel X3 revision 4](https://fuel.gazebosim.org/1.0/OpenRobotics/models/X3%20UAV/4)。大きなmodel/meshや第三者のsource本文は本PRへ含めない。製品用のoffline資産・ライセンス確認は#221で行う。
