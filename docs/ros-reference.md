# ROS 2参照環境

Issue #190の参照機体であり、MQTT Bridge、実機制御、Cloudへの結果保存は含まない。[ADR 0008](adr/0008-ros2-bridge-contract-and-recovery.md)の通信契約を実ROSで試す足場とする。既存のsimulatorと通常のComposeは変更しない。

## 起動と停止

Dockerだけで動く。ホストへのROS導入、AWS、実機は不要。

```sh
docker compose -p fleet-ros-reference -f compose.ros.yaml up --build -d
docker compose -p fleet-ros-reference -f compose.ros.yaml exec reference bash /workspace/tools/entrypoint.sh ros2 topic list --no-daemon
docker compose -p fleet-ros-reference -f compose.ros.yaml down
```

2台の設定は`ros/config/reference.json`にある。変更したら再buildする。1〜10台、ASCIIの英数字・`_`・`-`からなる一意なdevice IDを指定する。namespaceは`/fleet/d_<device IDのASCII byte列の小文字hex>`で、`a-b`と`a_b`も衝突しない。frameは同じprefixの`map`/`base_link`を使う。

専用Compose project内の1 containerだけを起動する。`network_mode: none`、DDS discoveryはlocalhostのみ、`ROS_DOMAIN_ID=42`であり、ホスト・既存サービスへportを公開しない。各deviceの2 nodeは参照server processに同居するが、試験clientは別process。将来のBridgeも別processとする。切断fixtureはserver process全体を終了するため、その試験では1台だけ起動する。`down`はこのprojectだけを削除する。base image/build cacheは残る。

## 固定する依存

Ubuntu 24.04 / Jazzy / Fast DDS (`rmw_fastrtps_cpp`) / Python 3.12 / colconを使う。`ros/locks/environment.json`に公式OCIのindex digest、arm64/amd64 manifest digest、公式Dockerfileのrevisionを記録した。`dpkg-*.tsv`は全debの完全version一覧で、build時に実環境と完全一致を検査する。

公式OCIに必要な依存が揃っているため追加のapt/pip/rosdep/vcs解決は行わない。rosdep定義を再取得しないので、未使用のrevisionを再現条件として作らない。依存の取得元snapshotはdigestで指定したOCIそのもの。初回取得にはregistryが必要であり、長期保存が必要な運用ではこのimageを保存する。tagの現在値やapt repositoryの存続には依存しない。imageが取得済みなら`--network=none`でworkspaceをbuildできる。

依存更新時はDockerfileのindex digestと環境manifest、両CPUのdeb lockを同じ変更で更新し、arm64/amd64の実ROS試験を再実行する。通常のbuildでlockを自動更新しない。

`/workspace/environment-manifest.json`にCPU、Python、deb一覧hash、source hashを残す。sourceのGit commitは実行時のcheckoutで記録する。異なるCPUでのbyte一致や壁時計時刻・UUID・DDS到着順の一致は保証しない。固定seed/configでhomeと出発位置、動作シナリオを再現する。UUID/server epochは起動ごとに変わる。

## 参照契約

各namespaceで`battery` (1Hz)、`odometry` (10Hz)、`diagnostics` (1Hz)、`runtime_state` (1Hz)を配信し、`get_runtime_state` serviceと専用`return_home` Actionを提供する。型定義は`ros/src/fleet_bridge_interfaces`を正とする。battery percentageは0〜1、位置はLOCALのm、速度はm/s。欠測temperatureはNaNで、GPSを持たないので`fix`は配信しない。

実行には観測が新鮮、batteryが20%以上、同じserver/configuration/home/frame、未実行command ID、空き状態が必要。`get_runtime_state`で得た識別子を使い`bridge_heartbeat`を1Hzで送る。smoke試験のprobeがこの役割を担う。heartbeatなしではgoalを拒否し、実行中に3秒途切れればabortする。これは参照モデルのwatchdogであり、実機の独立安全機構の実装ではない。

`ReturnHome`はgoal IDとROS transport UUIDの一致、開始期限、結果期限を確認する。homeへの距離0.2m以下、速度0.05m/s以下が1秒続いた場合だけ成功とする。Action受付・feedback・result・cancel受付は別の事実。結果の保持は同一processの900秒のみで、restart後の復旧は未実装。REBOOTやNav2への読み替えはしない。

command IDはUUIDをcanonical表記へ正規化して照合・保存する。同じUUIDの大文字/小文字・ハイフン有無は同一commandとし、終了後も別goalによる再受付を拒否する。この重複記録は同じserver process内だけで有効。

| scenario | 振る舞い |
| --- | --- |
| `success` | homeへ移動し安定条件を満たして成功 |
| `reject` | goalを受け付けない |
| `abort` | `failure_after_sec`経過後に失敗result |
| `unresponsive` | goal受付後にfeedback/result/cancel終端を返さない。watchdog/期限は有効 |
| `delayed_cancel` | cancel受付から`cancel_delay_sec`後に停止・CANCELED |
| `cancel_reject` | cancelを拒否し、通常実行を継続 |
| `disconnect` | `failure_after_sec`後にexit 72。resultを捏造しない |

seedはuint32、cancel delayは0〜5秒、failure delayは0.1〜10秒に制限する。設定hashは全参照設定のSHA-256であり、後続のwire契約のconfiguration hashとはまだ統合しない。Action/観測をMQTTへ変換する実装は#191以降。

## 実ROS試験

```sh
pnpm test:ros-reference
```

固定OCIからnetworkなしでbuildし、別process間の実DDSでpublisher/service/Actionを試す。2機体のframe・観測・実行件数の分離、seed再現、拒否/失敗/無応答/切断/遅延cancel/cancel拒否、別ROS domainの非検出を確認する。cancel受付だけで停止や成功と判定しない。試験終了時は子processを待ち、専用container/imageを削除する。SIGINT/SIGTERMでも同じ後始末を行う。既存containerには触れない。

CIはLinux amd64、ローカルMacのDockerはLinux arm64で同じ試験を実行する。ROSの取得元digestと生成manifestをログに残す。通信断後のBridgeの永続化・再照会やハードウェアの安全性は、この試験の証明対象ではない。
