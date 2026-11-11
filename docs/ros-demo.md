# v0.6.0 ROS 2デモと保証範囲

Phase 6（#188、#189〜#199）の入口。AWS・実機・host ROSなしで、参照node→Bridge→MQTT→DB→API→画面と、帰還・中断・結果不明を再現する。`v0.6.0`は機能の区切りで、Git tag / GitHub Releaseの発行や全packageのversion変更を意味しない。

## 1. 専用環境を起動する

Docker Engine / Compose v2、Node.js 22.13以上を使い、repository rootで実行する。初回buildには固定ROS OCIとNode依存の取得用networkが必要。ROS build自体はofflineで行う。ホストにROS・Python package・C++開発環境を入れない。

```sh
export ROS_DEMO_PROJECT=fleet-ros-demo
export API_PORT=31196 DASHBOARD_PORT=5176
docker compose --env-file /dev/null -p "$ROS_DEMO_PROJECT" -f compose.yaml -f compose.ros-demo.yaml build ros-demo-reference migrate telemetry-ingestor api dashboard
docker compose --env-file /dev/null -p "$ROS_DEMO_PROJECT" -f compose.yaml -f compose.ros-demo.yaml up -d --wait postgres mqtt migrate telemetry-ingestor api dashboard ros-demo-reference ros-demo-success ros-demo-cancel ros-demo-recovery
```

同じshellの環境変数を以後も使う。通常の`.env`を読まず、専用project/DB/volumeで既存の10台デモを維持する。APIとdashboardだけloopbackへ公開し、DB・MQTT・DDSは公開しない。port競合時は空きportへ変更し、dashboardを再buildする。`fleet-ros-demo`はこの手順専用に予約し、既存環境のproject名を流用しない。AWS認証情報は渡さない。

`ros/config/demo.json`の3機体を、同じ参照processと機体別Bridge/永続volumeで動かす。成功用`ros-demo-success`、即時中断可能な`ros-demo-cancel`、結果を返さない`ros-demo-recovery`を用意する。3台はデモ設定であり同時処理性能の保証ではない。migrateの`Exited (0)`は正常。`--wait`はComposeの起動確認でありROS readyではない。

[機体一覧](http://localhost:5176)から「ROS観測・実行・理由付き中断を追跡」へ進む。APIからも確認できる。

```sh
curl --fail "http://127.0.0.1:$API_PORT/devices/ros-demo-success"
curl --fail "http://127.0.0.1:$API_PORT/devices/ros-demo-success/bridge-configuration"
curl --fail "http://127.0.0.1:$API_PORT/devices/ros-demo-success/bridge-health"
```

最新観測はtelemetry v3、LOCAL / ENU / m。batteryは%、temperatureは電池の°C。緯度経度や海抜高度へ変換せず、欠測/null/UNKNOWNを0にしない。MQTT ONLINE、ROS到達、観測鮮度、操作ready、飛行状態を別々に読む。freshな構成/health/観測がそろうまでは操作しない。

## 2. 帰還と中断

次のhelperは実APIへ一度だけPOSTし、実DDS/Action/MQTT/DBの証拠をboundedに待つ。通信mockやgoal再投入はしない。結果のJSONにcommandId・goalId・構成ID・介入ID・追跡画面URLを出す。待機失敗前にもcommandId、中断送信前には元のIdempotency-Keyと理由をstderrへ記録する。失敗したPOSTを新しいkeyで自動再送しない。command受付応答自体を失った場合は`GET /devices/:deviceId/commands`とauditから既存履歴を照合し、新commandで応答を取り直さない。

```sh
node docs/examples/ros-demo.mjs success
node docs/examples/ros-demo.mjs cancel
```

- success：専用ReturnHomeのSUCCEEDEDと、別の参照停止観測を確認する。HTTP 202、受領ACK、GOAL_ACCEPTED、RETURNING_HOME feedbackだけでは合格にしない。
- cancel：既知goalへ`DEMO_OPERATOR_REQUEST`とIdempotency-Keyを付けて中断する。ROS受付、CANCELLED終端、stopConfirmation=OBSERVED、介入記録を別に確認する。中断確認期限は10秒で延長しない。処理・保存が遅れて不確定になった試行は、この正常中断デモの成功に読み替えない。

画面からも各機体へ「帰還させる」→確認を実行できる。中断はgoal受付後・終端前に理由を入力し、対象UUIDを確認して送信する。通常帰還は数秒なので、タイミングを再現する検証には上のhelperを使う。REBOOTは非対応で、node restartへ変換しない。

API単体の契約は`POST /devices/:deviceId/commands`（`{"type":"RETURN_HOME"}`）、`POST /devices/:deviceId/commands/:commandId/cancel`（`{"reason":"OPERATOR_REQUEST"}`とIdempotency-Key）。`GET /commands/:commandId/bridge-execution`、機体配下のcancel GET、`GET /commands/:commandId/bridge-configuration`とauditで、現在の構成と実行時の構成を分けて追跡する。

## 3. server世代喪失と人間への引き継ぎ

```sh
node docs/examples/ros-demo.mjs recovery --restart-reference
```

無応答の参照goalを受け付けた後、helperが**この専用projectの全3 Bridgeと参照serverを再起動**する。network/IPC namespaceを再接続し、機体別SQLiteとCloud DBは保持する。全参照機体のhome/server UUIDとprocess内cacheが失われる複合障害で、Bridge単独再起動やMQTT単独切断の試験ではない。

保存した元goal/config/serverを照合し、SERVER_CHANGED / UNCERTAIN・停止未確認・人間判断待ち、次commandの409拒否を確認する。新serverの受理/実行件数は0で、古いgoalを送って成功を作らない。実行時構成と過去結果は新serverへ差し替えない。画面ではhelperが出す元commandのURLから不確定の理由を読む。

復旧判断では、通信状態、server世代、元goal UUID、結果cache、eventの採否・CDR/hash、停止観測、journal容量/欠損、実機側の状態を順に確認する。参照モデルの検証であり実機状態の確認手順を代替しない。安全を確認できない予約の強制解除API、履歴消去や新goalによる穴埋めは提供しない。auditの引き継ぎ要求は人間の対応完了ではない。

MQTT単独切断後の蓄積/保存再開、同世代Bridge再起動後の元UUID結果照会は、第7節の`test:ros-e2e`の`mqtt-outage-HOME_REACHED` / `bridge-restart-queries-original-goal`で再現する。正常な保存再開と、停止未確認を残すケースを[復旧境界](ros-recovery.md)に沿って区別する。

## 4. ROSとMQTTの対応

namespaceは`/fleet/d_<deviceIdのASCII bytesの小文字hex>`。pose frameは先頭slashなしの同prefix `/map`、velocityは対応frameを保持する。domain 42・Fast DDS・LOCALHOST discovery、空static peersで、参照とBridgeだけnetwork/IPC namespaceを共有する。domain/namespaceは認証境界ではなく、LAN探索・host network・DDS port公開を行わない。

| ROS相対名 / 型 | 周期・QoS | Fleetとの対応 |
| --- | --- | --- |
| battery / BatteryState | 1 Hz、best effort / volatile / depth 5 | telemetry v3のnullable %・電池温度 |
| odometry / Odometry | 10 Hz、best effort / volatile / depth 5 | LOCALのpose m・linear m/s・angular rad/s |
| diagnostics / DiagnosticArray | 1 Hz、reliable / volatile / depth 10 | level/name/hardwareId、最大32 component |
| runtime_state / RuntimeState | 1 Hz、reliable / volatile / depth 1 | server/home/config/flight/goalの照合 |
| bridge_heartbeat / BridgeHeartbeat | 1 Hz、reliable / volatile / depth 1 | MQTTと独立したowner/goal生存確認 |
| get_runtime_state / GetRuntimeState | 非同期、service標準reliable / volatile / depth 10 | ROS到達性・active/last goal確認 |
| get_configuration / GetConfiguration | 同上 | CONFIGURATIONと実package/source/runtime報告 |
| get_goal_decision / GetGoalDecision | 最大1回2秒 | goal UUIDに合致した拒否理由/CDR/hash |
| return_home / ReturnHome | serviceはreliable、feedbackはbest effort / volatile / depth 10。statusは標準Action status QoS | command v3→goal、bridge-eventsの受付/進捗/終端/停止。中断は特定UUIDのCancelGoal |

`fix` / NavSatFixは参照nodeが発行しない。対応時の単位はdeg、altitudeはWGS84楕円体基準mでLOCAL zとは別である。詳細は[観測変換](ros-observations.md)と[ADR 0008](adr/0008-ros2-bridge-contract-and-recovery.md)。ROS source stamp、Bridge受信UTC、snapshot UTC、DB受信UTCを分離する。`/clock`や`use_sim_time`をUTC期限へ流用せず、鮮度・待機はmonotonicで測る。source時計の0/逆転/跳躍はwindowを破棄し、未測定を補完しない。

MQTTは`fleet/v1/devices/{deviceId}/`配下、ROS経路はすべてQoS 1・retainなし。telemetry v3とtelemetry-receipts v1、commands v3と受領ACK v2、bridge-events v1とbridge-receipts v1、bridge-requests v1のCANCEL_COMMANDを使う。PUBACKはDB保存や実行成功ではなく、BridgeはSQLiteへ保存し、ingestorのDB commit後receiptとscope/hashを照合して未確認outboxを削除する。QUERY_COMMAND_STATEという外部要求は未実装。

## 5. version・更新・保証の境界

現在のBridgeは0.5.0、Adapter/interfacesは0.4.0、Capability Profileは1.1.0、SQLite schemaは7。v0.6.0という呼称からこれらを推測せず、`bridge-configuration`のreportedとcommandに固定されたsnapshotを読む。desiredは配信/適用/実行証明ではない。実package version・source digest・ROS環境manifest、policyと安全設定を保存するが、自己申告と信頼した実装の境界があり暗号学的な実行証明ではない。AIは未使用、費用・人間の対応終了/所要時間は未報告nullで、0や架空のversionを作らない。

更新はROS command受付停止→旧ingestor停止→DB migration（ROSは0021〜0025。既存migrationも順に適用する）→protocol/ingestor/API/worker→interfaces/AdapterとBridge→新鮮な報告/観測/health照合→受付再開とする。既存journal/UUIDを保持し、未停止・不確定な実行を更新で消さない。通常simulatorのcommand v2/ACK v3、旧telemetry、opt-in OTAは維持する。Bridge自体を既存simulator OTAで更新する機能やDB downgradeは提供しない。

| 層 | 責務と保証しないこと |
| --- | --- |
| Fleet API/ingestor/DB | 能力・固定対象/構成・期限・排他、保存正本/receipt、集約/audit。制御周期・本人認証・物理停止は保証しない |
| Bridge | 検証/変換、SQLite対応、元UUIDの結果再照会。SendGoalとSQLiteは非原子的で、exactly-once実行や無条件の再投入を保証しない |
| Adapter/参照node | battery 20%以上、sensor age 3秒未満、homeから10 m以内、frame/owner/config/期限/排他。帰還は誤差0.2 m・速度0.05 m/s以下の1秒継続。Cloud/AIが制約を解除する経路はない |
| 安全機構 | heartbeat 3秒喪失等で参照モデルを停止/ABORTEDにする。同じprocess内の制約であり、process/host故障・motor・独立非常停止・安全認証・実機の物理安全停止は保証しない |

開始期限30秒、結果期限120秒、参照実行上限60秒。同processのresult cacheは既定900秒で、server restart後の保持ではない。GetResultは元UUIDに最大5回/30秒、1回2秒・1〜8秒backoffで、再起動で予算を戻さない。終端後の停止観測は5秒以内・1秒継続を必要とし、中断確認は要求から10秒。欠測・遅着・矛盾は不確定/人間判断へ渡す。MQTT接続復旧は停止・Task成功ではない。

重要journalは最大10,000件/32 MiBの論理本文量で、満杯/書込不能時は新規操作を停止する。DB/WAL/indexの物理容量、disk/volume喪失、ROS受信/SQLite commit前、brokerの保持喪失は保証外。telemetryは別の有界outboxで古い未確認値を破棄し欠損を記録する。重要eventを消してreadyへ戻さない。

## 6. 停止・削除と再実行

```sh
docker compose --env-file /dev/null -p "$ROS_DEMO_PROJECT" -f compose.yaml -f compose.ros-demo.yaml down
```

停止だけならSQLite・DB・MQTT volumeを残す。再起動では参照serverの世代が変わるため、過去commandの不確定やjournal不整合を自動解除しない。既存データを復旧のために消す手順ではない。

**この使い捨てデモだけ**を初期状態へ戻す場合は、project名を確認して削除する。3機体のjournal、DB履歴、MQTTデータは復元できなくなる。

```sh
docker compose --env-file /dev/null -p "$ROS_DEMO_PROJECT" -f compose.yaml -f compose.ros-demo.yaml down --volumes --remove-orphans
```

通常開発projectのvolumeやDocker全体をpruneしない。image/build cacheは上の手順では残す。helper失敗後は新commandで再試行せず、まず元commandIdとサービスログを確認する。

## 7. 検証記録と後続Phase

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test:ros-demo
corepack pnpm test:ros-e2e
```

`test:ros-demo`は上の3シナリオとdashboard HTTPを専用UUID projectで実行し、成功/失敗/INT/TERMで専用資源を削除する。表示したResults directoryへsuccess/cancel/recovery JSON、commit、Docker/Node/ROS環境manifest、サービスログ、cleanup.jsonと残存照会を保存する。対話デモとは異なり、終了後に画面/DBを保持しない。これは実ブラウザのlayout検証ではない。

[#198のPR #210](https://github.com/wmsuke/drone-fleet-platform/pull/210)と[CI run](https://github.com/wmsuke/drone-fleet-platform/actions/runs/42944162226)にnative Linux ARM64/AMD64の33ケース成功、25 device（batch最大10台）、27 command/goal・18結果/構成binding・7介入、cleanup残存0を記録した。HTTP往復遅延はhost harnessの標本で、DDS/制御周期・大規模性能の保証ではない。[障害E2E](ros-e2e.md)のreportがPASSED/FAILED/NOT_EXECUTEDを分ける。artifactは14日保持であり、失効後は固定commitで再実行する。

ROS専用checkは`ROS 2 reference and Bridge lifecycle smoke`（本デモを含む）と`ROS 2 DDS, MQTT and dashboard fault E2E`。通常品質checkは`Lint, typecheck, test, and build`。今回のcommit・実環境・試行と各checkの結果はPRへ記録し、上記の#198時点の結果と混同しない。

Python/rclpyは固定Jazzy環境で非同期clientと小さな参照モデルを扱うため採用した。性能比較やhard realtime要件による選択ではない。独自C++アプリは追加せず、ament_cmake/rosidlがinterface bindingを生成する。`ros/tools/dds_fault.c`は#198系の試験専用UDP fault shim（C）で、通常デモではロードしない。

Phase 7へはPX4/Gazebo等の実シミュレータ接続、Adapterの意味対応とTask成功条件・期待結果/観測証拠・executionContextの定義を渡す。Phase 8へはmodel/versionの適用と比較baseline、成功率/時間/コスト等KPIの評価を渡す。現在のAction成功、接続復旧、構成digest、HTTP待ち時間をTask成功・model効果・人間の作業時間へ読み替えない。実機、実AWS ROS経路、DDS Security/LAN、別RMW、PX4/AIモデル、大規模性能は未検証である。
