# ADR 0008: ROS 2 Bridgeの責務・通信契約・復旧境界

- 状態: 採用する設計。#190で参照workspaceと実ROS smokeを追加した。Bridge・新schema/API/DB・Cloud連携E2Eは#191〜#199で実装する
- 決定日: 2026-11-05
- 対象: [親Issue #188](https://github.com/wmsuke/drone-fleet-platform/issues/188)、#189〜#199、Phase 6 / v0.6.0
- 前提: Phase 5の#176 / PR #200は完了。現行の[通信仕様](../protocol.md)、[command期限](../command-durability.md)、[実行結果](../command-results.md)、[ADR 0005](0005-delivery-and-recovery.md)を維持する
- 計画: [実行評価・Physical AI計画](https://app.notion.com/p/3fe512303eae818cb481e62a47ed9c42)。汎用TaskとexecutionContext全体はPhase 7以降であり、本ADRで実装済みにしない

## 1. 採用構成と理由

開発ホストはmacOS arm64、DockerはLinux arm64、既存CIはubuntu-latest上でLinux containerを実行する。ROSはホストへ直接導入せず、Ubuntu 24.04 NobleのLinux arm64/amd64 containerへ固定する。ROS distributionはJazzy Jalisco、RMWは`rmw_fastrtps_cpp`（Fast DDS）、Bridge/参照nodeはPython 3.12と公式`rclpy`を採用する。ROS interface生成のみ`ament_cmake`、Python packageは`ament_python`、build/testはcolconとする。Fleet側のTypeScript/Node.js 22は変更しない。

JazzyのNoble arm64/amd64とFast DDSの対応は[REP 2000](https://github.com/ros-infrastructure/rep/blob/master/rep-2000.rst#jazzy-jalisco-may-2024-may-2029)、deb導入は[公式Jazzy手順の原文](https://github.com/ros2/ros2_documentation/blob/jazzy/source/Installation/Ubuntu-Install-Debs.rst)で確認した。macOSでのnative buildや非公式Node.js ROS bindingより、両CPUで同じ公式Python clientを使える構成を優先する。Rollingの追随、C++アプリ、Cyclone DDSとの併用、別RMW間の互換試験は初期対象外とする。選定は性能比較の結果ではない。

#190で`ros/locks`に公式OCIのindex/CPU別digest、全debの完全version一覧と取得元Dockerfile revisionを固定した。取得元snapshotはOCI自体であり、追加のapt/pip/rosdep/vcs解決は行わない。そのためrosdep定義revisionの固定は不要とし、未使用をmanifestへ明記する。workspace commit/変更状態とsource hashは試験結果へ記録する。詳細は[参照環境](../ros-reference.md)を参照する。`latest`、apt upgrade、rosdepの実行時更新を再現の根拠にしない。将来Python追加依存が必要になればhash付きlockへ固定し、MQTTには[Paho Python](https://github.com/eclipse-paho/paho.mqtt.python)を使う。base tagだけの固定は不十分である。

Python側でZod契約を手書き複製しない。`packages/protocol`をwire契約の正とし、#191以降でJSON Schemaの生成物・hashとPython validatorを固定し、同じ正常/不正fixtureを両言語で検証する。SQLiteとPython MQTTの実装は既存TypeScriptの部品を直接流用できないため、同じ保存/期限/receipt規則を共有fixtureで検査する。今回、依存追加やホストのROS導入は行わない。

JSON Schemaで表せない期限・scope相関・canonical JSON/hash・拒否規則も共通fixtureの対象にし、schemaの生成だけで同じ検証とみなさない。再取得可能なapt snapshotがない場合は検証済みdeb/OCI imageを保存し、version一覧だけで再build可能と主張しない。

## 2. 配置・責務・公開範囲

```text
Cloud API / outbox → MQTT → Edge Bridge → 機体Adapter → ROS Action server
Cloud DB ← ingestor ← MQTT ← Edge Bridge ← topic / feedback / result
                                               機体側制約・watchdog
```

| 層                   | 担当                                                                                  | 担当しないこと                                        |
| -------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Cloud Fleet Platform | command受付・期限・対象/能力/構成snapshot、配送、保存済み事実の集約、audit/介入       | ROS discovery、制御周期、Cloud依存の緊急停止          |
| Edge Bridge          | MQTTとROSの検証・変換、SQLite、command/goal対応、結果再照会、配送再送、通信状態の分離 | 汎用Task planner、未確認goalの再実行、成功/停止の推測 |
| 機体Adapter          | 型/単位/frame・Action意味・Capabilityの対応、結果条件、拒否理由                       | 未対応能力の補完、他機体へのgoal転送                  |
| 参照機体node         | 観測publisher、専用Action実行、期限/排他/制約の再検証、ローカルwatchdog               | 実機制御、安全認証、Cloudからの無条件な制約解除       |

参照環境はBridgeと参照nodeを独立processとして同じ専用Linux containerのnetwork namespaceに置く。`ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST`、`ROS_STATIC_PEERS`は空、`ROS_DOMAIN_ID=42`を明示する。複数deviceは同じdomain内で別namespaceにし、同時試験は別containerで隔離する。DDSのUDP port公開・host network・LAN探索を使わず、MQTTだけを専用Compose networkへ出す。macOS上のhost multicastへ依存しない。MQTT秘密鍵はBridgeだけへ渡し、参照nodeの環境やログへ渡さない。これを悪意の同居processに耐えるsandboxとは扱わない。

domainとdiscoveryの挙動は[公式discovery](https://github.com/ros2/ros2_documentation/blob/jazzy/source/Concepts/Basic/About-Discovery.rst)、[discovery範囲](https://github.com/ros2/ros2_documentation/blob/jazzy/source/Tutorials/Advanced/Improved-Dynamic-Discovery.rst)、[domain ID](https://github.com/ros2/ros2_documentation/blob/jazzy/source/Concepts/Intermediate/About-Domain-ID.rst)を参照する。domain IDやnamespaceは認証・暗号化・権限分離ではない。実機/LANへ広げる場合はDDS Security、firewall、peer固定を別ADRで決める。

deviceIdは現行ASCII最大64文字を維持し、ROS namespaceにはUTF-8 bytesの小文字hexを用いた`/fleet/d_<hex>`を一意に割り当てる。`-`等を単に`_`へ変換して衝突させない。frameは先頭slashなしの`fleet/d_<hex>/map`、`.../odom`、`.../base_link`とし、他機体frameを拒否する。device/topic/namespace/profileの対応を設定digestへ含める。

## 3. 参照graphとQoS

参照publisher `reference_vehicle`、Bridge `fleet_bridge`、機体側Action server `reference_adapter`をdevice namespace配下へ置く。topicは観測、serviceは短い照会、Actionは継続実行・feedback・result・cancelに使い分ける。自動discoveryでserverを見つけても対応型・実行中goal・能力が確認できるまではreadyにしない。

BridgeはMultiThreadedExecutorと非同期clientを使い、ROS callback内で同期SendGoal/GetResult/cancel待ちをしない。MQTT callbackもbounded queue（最大100件）へ渡し、SQLite保存・変換を専用workerで行う。満杯なら新操作を受領済みにせず、重要結果はROS/SQLite側の正本から照合する。実executorと終了時の未処理queueの検証は#191へ渡す。

| 名前（namespaceからの相対名） | ROS型・役割                                                                                                  | 参照QoS・周期                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `battery`                     | `sensor_msgs/msg/BatteryState`                                                                               | best effort / volatile / keep last 5、1 Hz                                                                                                         |
| `odometry`                    | `nav_msgs/msg/Odometry`、poseとtwist                                                                         | best effort / volatile / keep last 5、10 Hz                                                                                                        |
| `fix`                         | `sensor_msgs/msg/NavSatFix`、測定がある場合のみ                                                              | best effort / volatile / keep last 5、1 Hz                                                                                                         |
| `diagnostics`                 | `diagnostic_msgs/msg/DiagnosticArray`                                                                        | reliable / volatile / keep last 10、1 Hz                                                                                                           |
| `runtime_state`               | 独自`fleet_bridge_interfaces/msg/RuntimeState`、server起動UUID・適用構成・機体状態・watchdog理由             | reliable / volatile / keep last 1、1 Hz                                                                                                            |
| `bridge_heartbeat`            | 独自`fleet_bridge_interfaces/msg/BridgeHeartbeat`、Bridge→参照serverの生存・owner/goal/config/server世代照合 | reliable / volatile / keep last 1、1 Hz。MQTT接続状態とは独立                                                                                      |
| `get_runtime_state`           | 独自`GetRuntimeState.srv`、freshな稼働構成/active goal照会                                                   | reliable / volatile / keep last 10                                                                                                                 |
| `return_home`                 | 独自`ReturnHome.action`、既知のhomeへの帰還                                                                  | goal/result/cancel serviceはreliable / volatile / keep last 10、feedbackは両端best effort / volatile / keep last 10、statusは標準Action status QoS |

QoSは両端で明示する。不適合なら接続しない場合があるため、受信ゼロを値0・成功とみなさない。[公式QoS](https://github.com/ros2/ros2_documentation/blob/jazzy/source/Concepts/Intermediate/About-Quality-of-Service-Settings.rst)の互換規則を使い、incompatible QoS eventとpublisher停止を別に記録する。QoS reliableは操作の永続性・exactly-once実行を保証しない。参照nodeは観測のdeadlineを2秒、Bridgeは最終受信のmonotonic age 3秒をstale境界とする。deadline/liveliness通知だけへ依存せずtimerでも検出する。Action statusは照会の補助であり終端result・停止観測の代替にしない。

service照会は1回2秒、最大3回・合計10秒以内。Action goal応答は5秒、参照Actionの実行上限60秒、Cloudの結果確認期限は受付から120秒を初期値に固定する。これらは参照実装の設計値で、実測性能・機体安全値ではない。result待ちの期限でgoalを消去・再投入しない。

## 4. 観測の意味変換と時計

現行telemetry v1/v2はbattery、緯度経度、非負altitude、temperature、飛行状態が必須で、DBもNOT NULLである。ROSの欠測・ローカル位置を0やGPSへ変換することは禁止する。#192で同じtelemetry topicに**telemetry v3（ROS観測）**を追加し、v1/v2の意味と保存先を変えない。

v3は既存のdeviceId/UUID v4 sessionId/sequence/UTC timestampを保持し、payloadに`source: ROS2`、nullableなbattery/temperature、`position: LOCAL / GEODETIC / null`、`flightStatus`（既存3値＋UNKNOWN）、diagnostics、field別quality/reasonと元のsource stamp/time domainを持つ。LOCALはframeId・m単位xyz、GEODETICは緯度経度deg・nullable altitudeと高度基準を必須にする。欠測値はnullと理由で表し、NaN/InfinityをJSONへ送らない。厳密なZod schema・fixtureは#192で実装し、このADRでは現行parserを変更しない。

| ROS値                             | Fleet v3での意味・欠測/拒否                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BatteryState.percentage / present | present=trueかつ有限の0〜1を100倍して%。NaN・範囲外・電池不在はbattery=null＋理由。0と欠測を区別                                                                               |
| BatteryState.temperature          | 有限の摂氏値だけtemperatureへ。NaNはnull。別センサーの外気温と混ぜない                                                                                                         |
| Odometry.pose / twist             | header.frame_idのposeとchild_frame_idのtwistを区別し、m・m/s・rad/sを保持。既定はLOCAL、zが負でもそのまま保持。frame不一致・未取得transformは無効、GPSや旧altitudeへ投影しない |
| NavSatFix                         | fix有効・有限の緯度経度のみGEODETIC。高度はWGS84楕円体基準mで、海抜や相対高度ではない。未測定はnull、負値を0へ丸めない。参照nodeにGPSがなければfixを発行しない                 |
| DiagnosticArray                   | component名・hardware_id・OK/WARN/ERROR/STALE・測定/受信時刻を保持。全体OKやONLINEを飛行可能へ読み替えない。自由文字列は長さ制限・秘密値除外                                   |
| runtime_state                     | Adapterが定義した状態だけをflightStatusへ変換。不明はUNKNOWN。速度0、電源ON、MQTT接続だけでIDLEを推測しない                                                                    |

標準message定義は[BatteryState](https://github.com/ros2/common_interfaces/blob/jazzy/sensor_msgs/msg/BatteryState.msg)、[Odometry](https://github.com/ros2/common_interfaces/blob/jazzy/nav_msgs/msg/Odometry.msg)、[NavSatFix](https://github.com/ros2/common_interfaces/blob/jazzy/sensor_msgs/msg/NavSatFix.msg)、[DiagnosticStatus](https://github.com/ros2/common_interfaces/blob/jazzy/diagnostic_msgs/msg/DiagnosticStatus.msg)を参照する。単位/右手系は[REP 103](https://github.com/ros-infrastructure/rep/blob/master/rep-0103.rst)、map/odom/base_linkの意味は[REP 105](https://github.com/ros-infrastructure/rep/blob/master/rep-0105.rst)に従う。参照LOCALはENU・m、home frameを明示し、TFの不足を推定変換で埋めない。

送信timestampはBridgeが観測snapshotを作ったUTC、source stampはROS時刻として別保存する。`use_sim_time`/`/clock`はUTCではなく、停止・逆転・未初期化を許すのでcommand期限に使わない。[ROS time設計](https://github.com/ros2/design/blob/gh-pages/articles/130_ros_time.md)を参照する。受信間隔とtimeoutはmonotonic、API期限は同期したwall UTCとし、時刻不信なら新操作を拒否する。source stampの0・逆転・大きな飛びで当該観測windowを破棄し、時計世代を更新してfreshなsourceを待つ。再送時にtimestampを現在へ差し替えない。

Bridgeは最新値を最大5秒周期でまとめ、topic別queue上限はQoS depth、diagnosticsは最大32 component・文字列各256文字・packet全体32 KiB、超過は切詰めフラグ/欠測理由を残す。ROS受信前・stale値からtelemetryを捏造しない。受信がない項目を含むsnapshotはnull/STALEとし、新規sourceなしの周期再送をfresh sampleに数えない。MQTT ONLINE（Bridge接続）、ROS接続、観測鮮度、飛行状態は別軸にする。

#192でv3は専用`ros_observations`へ保存し、device登録/接続判定・APIの最新観測/履歴を同じdeviceに統合する。旧`telemetry`のGPS列や地図へLOCALを流さない。v2/v3を通した共通identity台帳で(deviceId, sessionId, sequence)を一意にし、同identity別本文を衝突記録へ分離して正本を変えない。receipt v1は同identityのDB commit後STOREDとして維持する。Bridge起動で新session、MQTT再接続ではsessionを変えず、SQLiteへ保存した旧sessionもreceiptまで再送する。

永続telemetryは10,000件/32 MiB、超過は最古未確認を破棄して欠損記録、書込失敗では生成停止とする。ROS受信前/SQLite commit前の欠測は配送保証外。欠測batteryで低電池alertを解除せず、#192で有効値だけ評価するよう利用側も更新する。LOCAL/UNKNOWNの画面表示は#197で対応し、それまでは未対応表示として地図・飛行状態を補完しない。

## 5. commandとActionの意味・構成固定

初期対応はRETURN_HOMEだけで、`ReturnHome.action`を新設する。Fibonacci、NavigateToPose等を名前だけ変えて流用しない。REBOOTは接続世代/再購読/ONLINE PUBACKという現行意味を満たす機体Adapterがないため非対応であり、node restartやgoal cancelへ変換しない。

参照ActionのgoalはdeviceId、commandId、goal UUID、server起動UUID、expectedConfigurationId、開始UTC期限、実行UTC期限、固定homeId/frameIdを持つ。homeは参照server起動時に実poseから明示登録し、実行中は変更しない。resultはgoal/server UUID、startedAt/finishedAt UTC、成功/拒否理由、最終pose/速度、home誤差と継続時間、適用構成IDを返す。feedbackはphase・距離・開始時刻を返すが成功証拠ではない。Action名に任意URL/実行コマンドを含めない。

`SendGoal.goal_id`とgoal本文のUUID、result/feedbackのUUIDを一致させる。runtime_state/GetRuntimeStateはactiveGoalIdとlastTerminalGoalIdを区別して返し、終端後の停止観測を別goalへ結び付けない。server再起動でhomeや世代が変わった場合、古い要求を新しいhomeで実行しない。

参照成功は同じmap frameのhomeから3次元距離0.2 m以内、速度0.05 m/s以下を1秒継続し、全観測が3秒未満で、Action result SUCCEEDEDと構成/goalが一致した場合だけとする。参照nodeがこの条件と拒否/失敗を生成し、Bridgeは根拠を検証・保存する。着陸、GPS帰還、障害物回避、実機到達、安全保証へ拡張しない。

#193のCapability ProfileにprofileId/version/digest、型式、許可command→Action型/名前、単位/frame、必要sensor、home定義、制約を固定する。Bridge/Adapterのversion・release digest、ROS distro/RMW/Pythonのruntime manifest digest、運用policy ID/version/digest、安全設定ID/versionを報告する。運用policyはAWS IoT Policyではない。desiredとreportedを別にし、commandの開始時に報告構成の不変snapshotを保存する。同じID/別本文・古い報告・未知versionは拒否し、更新後も過去goalの参照を差し替えない。AI未使用はNOT_APPLICABLEとし、架空のmodel versionを加えない。

構成報告にはdevice journalで永続増加するconfigurationRevisionとreportSequenceを持たせる。再接続/Bridge起動sessionだけでは新旧を決めず、既保存以下の報告は履歴に残して現在構成を戻さない。journal消失でcounterを0へ戻した場合は自動上書きせず再登録・介入を必要とする。revision更新中にactive/不確定goalがあれば構成切替を拒否する。

新規操作は現在構成と能力・鮮度・時刻・OTA予約・機体排他をAPIとBridge双方、さらに機体側で確認する。1device同時1goal。ROS喪失/前goal不確定中は別commandや別Bridgeからの操作も許可しない。機体側serverにも同時実行拒否を持たせる。ローカルOS lockでBridgeを1ownerに制限し、Cloud lease失効やMQTT clientId競合を停止証明にしない。

## 6. 永続対応・結果・再起動

#194でROS対象command v3を追加し、v2のtype/30秒開始期限を維持したまま、targetKind=ROS2・expectedConfigurationId・resultDeadline（API受付から120秒）を必須にする。通常simulatorにはv2のまま送り、ROS用v3を配送しない。goal UUIDはBridgeが新規commandへ一度だけ生成し、16 byte表現とcanonical UUIDを一意に相互変換する。新しいcommandだけが新goalを持つ。同command/別本文は拒否する。

SQLiteにdevice/command/payload hash、goal UUID、namespace・Action型、server起動UUID、構成snapshot、元期限、ローカル状態、ROS結果原文hash、event outboxを保存する。WAL/synchronous FULLでcommitできなければ送信しない。機体ローカルlockとjournal・通常telemetry DBを永続領域へ置く。詳細な採用理由は[Action設計](https://design.ros2.org/articles/actions.html)と[rclpy client実装](https://github.com/ros2/rclpy/blob/jazzy/rclpy/rclpy/action/client.py)を参照する。

| 境界・観測                                   | 永続状態／再開時の扱い                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 受領commit前                                 | 再配送時に検証から開始。未保存の受領ACKは出さない                                                                                                    |
| RECEIVED/READY、送信意図前                   | 同本文・能力・排他・新鮮なserver世代を再検証し、開始期限内だけ送信準備可能                                                                           |
| SEND_INTENT commit→SendGoal呼出し→応答保存前 | 操作とSQLiteは原子的でない。再起動後はUNCERTAIN。同じ/別UUIDでSendGoalを再発行しない                                                                 |
| goal accepted、実行前/中                     | goal UUIDとserver世代を保存。actual startedAtを含むfeedback/resultでRUNNINGを記録。acceptだけを実行開始/成功にしない                                 |
| 明示goal reject                              | NOT_STARTEDと理由を保存。ACKNOWLEDGED済みでも受領事実を消さず、実行REJECTEDとして保持。startedAtを捏造しない                                         |
| 終端result保存後、MQTT送信前/後              | 元eventId/hashで再送し再実行しない。PUBACKでeventを削除しない                                                                                        |
| Bridge再起動、同じserver世代                 | 保存goal UUIDへGetResultと現在stateを非同期照会する。rclpyの旧process内GoalHandleを復元できると仮定せず、Action生成GetResult serviceのUUID要求を使う |
| server再起動/UNKNOWN goal/cache期限/応答なし | 過去の成否・停止を推測せずUNCERTAIN、排他保持、人間判断。新goalで穴埋めしない                                                                        |
| journal/volume破損・owner不明                | 新規操作停止。再初期化や自動bootstrapで履歴を消さず介入へ                                                                                            |

参照serverのresult cache保持は明示900秒とし、同server生存中のみ再照会可能とする。[rclpy server](https://github.com/ros2/rclpy/blob/jazzy/rclpy/rclpy/action/server.py)のcacheは永続DBではなく、restart後の履歴を保証しない。Bridgeは2秒timeout・1秒から上限8秒のbackoff、最大5回/合計30秒の再照会で打ち切り、以後は記録と手動照合へ移す。activeかもしれないgoalを再送して応答を得る方法は禁止する。

GetResultは生成された`<action>/_action/get_result`へ保存UUIDを指定する。1goalの照会は同時1件とし、timeoutしたローカルfuture/待ちを解除してから次へ進む。照会futureの取消をgoalのcancelと混同しない。再起動後のruntime heartbeatはserver世代・構成・active/last terminal goalがjournalと照合できてから再開し、不明なままwatchdogを延命しない。

期限はAPI/Bridge/参照serverの同期UTCで照合し、`now >= expiresAt`なら開始しない。serverはDDS遅着とaccept後の実行待ちでも開始直前に検査する。開始済み処理は開始期限だけで未実行へ戻さない。結果期限超過はUNCERTAINとし、後着の確かなresultは別の履歴で照合できるが、元の期限内成功や自動再試行へ読み替えない。

Bridgeのcommand/goal履歴と重要eventは自動削除せず10,000件/32 MiB手前で新規操作を拒否する。満杯・保存不能を理由に未確認goal/eventを消さない。参照server側のcache消失、Bridge disk消失、ローカル操作とDBの非原子性があるためexactly-once実行は保証しない。既存simulatorの7日/件数上限付き履歴と同じ保証へ黙って置き換えない。

## 7. cancel・終端・停止の競合

#195で`POST /devices/:deviceId/commands/:commandId/cancel`を追加する。理由コード・Idempotency-Keyを必須にし、cancelId、対象command/goal UUID/server世代、作成/送信期限、操作者を固定する。cancel送信は作成後10秒以内、最大3回、同じcancelId/対象だけを再送する。全goal cancel（zero UUID）や時刻指定の一括cancelは禁止し、対象UUID＋zero timestampで特定goalだけを指定する。[CancelGoal契約](https://github.com/ros2/rcl_interfaces/blob/jazzy/action_msgs/srv/CancelGoal.srv)を参照する。

command→goal対応がまだ確認できない受付直後やSEND_INTENT不明では、APIは409 GOAL_UNCONFIRMEDでcancelを実行せず、照会・人間判断へ進む。cancelのためにgoalを作り直さない。機体側から明示的に拒否されたgoalを、cancel再送で実行へ進めない。

| 事実                                          | 表示・記録・後続                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| HTTP 202 / MQTT PUBACK                        | 要求受付/送信。cancel未確認                                                 |
| cancel応答accepted・goals_cancelingに対象あり | CANCEL_ACCEPTED/CANCELING。終端や停止確認ではない                           |
| reject / unknown goal / already terminal      | 理由を保存しGetResult照会。停止済みとはしない                               |
| result SUCCEEDEDが先/後に届く                 | 成功条件を満たす同goalの確定結果を保持。cancel要求でCANCELLEDへ書き換えない |
| result CANCELEDが届く                         | 実行CANCELLED（ROS表記はCANCELED）を保存。停止観測は別に確認                |
| result ABORTED・機体側拒否                    | FAILED/REJECTEDとreason。cancel成功や正常停止へ読み替えない                 |
| cancel後10秒以内に終端なし                    | cancel確認UNCERTAIN、人間判断。再実行・物理停止を推測しない                 |
| 確定した終端同士が矛盾                        | conflictとして双方を保存し、先の正本を上書きしない。排他を自動解除せず介入  |

参照の停止確認は終端resultとは別に、同server/goal/configのfreshなruntime_stateとpose/速度から、速度0.05 m/s以下・安全制約が要求するIDLEを1秒継続で観測し、終端後5秒以内に確認できることを要求する。timeout/欠測ならstopConfirmation=UNKNOWN、排他を残す。停止確認が取れても中断goalを成功にせず、resultだけでも物理安全停止の証明にしない。終端/停止/再接続それぞれの証拠IDを残す。

## 8. 通信断・独立した拒否・介入

MQTT切断では既に受け付けたgoalを再投入せず、機体側の期限・制約の範囲で継続し、観測/結果をSQLiteへ蓄積する。Cloud切断をAction failureや停止成功にしない。DDS/参照node喪失ではMQTTがONLINEでもROS_UNAVAILABLEとし、新規操作を拒否する。Bridge再起動では保存goalを照会するだけで、Action server再起動は別server世代として扱う。

参照serverはCloud/Bridgeとは独立に、許可frame/home、構成一致、開始/実行期限、battery有効かつ20%以上、sensor age 3秒未満、同時goalなし、ローカル領域（homeから10 m以内）を検査する。実行中の検査は10 Hz、Bridgeからの1 Hz runtime heartbeatが3秒以上途絶した場合やsensor/policy違反ではローカル更新を止め、ABORTEDと`BRIDGE_WATCHDOG` / `SENSOR_STALE` / `LOW_BATTERY` / `POLICY_REJECTED`等の理由と停止観測を記録する。MQTT切断だけではこのheartbeatを止めない。

これらは参照nodeの拒否・停止ロジックであり、制御プロセス自体の停止やhost故障にも耐える独立ハードウェア安全機構ではない。安全認証・実機の速度/領域制約は保証しない。Cloud/AIからwatchdog・battery制約を解除するAPIは設けない。機体にない能力や古い観測をCloud側の判断で補完しない。

Bridgeのjournal書込不能・owner喪失では新規操作を拒否してruntime heartbeatを停止し、参照serverのwatchdogへ渡す。これは停止成功の保証ではなく、結果を保存できなければCloudは不確定を保持する。容量確保のために履歴や前goal対応を捨ててreadyへ戻さない。

拒否、通信断/復帰、goal/result、cancel、停止観測、構成不一致を理由コード・時刻・device/command/goal/config/event ID付きで保存する。#193〜#196でBridge用介入記録を追加し、既存のaudit保存規則を使う。OTA専用`ota_interventions`へROS操作を押し込まず、Bridgeの対応開始/終了・判断を専用scopeで記録する。actorは既存HTTP同様anonymous/null、workerは明示system識別であり、本人性を保証しない。同期操作の受付時間を実作業時間へ補完せず、費用と未報告durationはnullとする。

## 9. wire・DB・権限差分と更新順序

新規の事実を未知項目として旧schemaへ付加するとstrip/拒否される。次の契約は後続Issueで明示的に追加し、現在使えるAPI/topicとして案内しない。

| 経路                                | 採用する変更・責務                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry` / `telemetry-receipts`  | #192のROS v3・専用観測行と共通identity台帳、receipt v1を維持。v1/v2を破壊しない                                                                                                                   |
| `commands` / `command-acks`         | #194のROS command v3。受領/期限拒否ACK v2を維持し、goal受付と実行結果をACK受領へ混同しない                                                                                                        |
| `bridge-events` / `bridge-receipts` | #193〜#196で各schemaVersion 1を追加。CONFIGURATION、GOAL_ACCEPTED/REJECTED、EXECUTION、FEEDBACK、CANCEL、STOP_OBSERVATION、ROS_HEALTHを区別し、ingestorが正本/拒否履歴と状態投影をcommit後receipt |
| `bridge-requests`                   | #195のv1。kind=CANCEL_COMMANDまたはQUERY_COMMAND_STATE、requestId・期限・command/goal/config/server世代を固定。cancelだけcancelId必須。任意Action・zero UUID・期限なし要求を拒否                  |

新topicも`fleet/v1/devices/{deviceId}/`配下、QoS 1・retainなしとし、deviceは自機events publish・requests/receipts subscribe/receive、APIはrequests publish、ingestorはevents subscribe/receive・receipts publishだけを追加する。既存telemetry/command/status権限は維持し、他機体・wildcard publish・DDS公開権限を与えない。#191は既存topicだけで起動し、新topic利用は各schema/受信側・Policyを揃えてから許可する。実AWSへの適用は別途#64の費用・時間条件を確認し、このIssueでは行わない。

bridge-eventの共通envelopeはdeviceId、eventId（UUID）、Bridge起動sessionId、単調sequence、発生UTC、server受信UTC（サーバー付与）、kind、configurationId、該当時commandId/goal UUID/server世代/cancelId、定義済みreasonを持つ。CONFIGURATION/ROS_HEALTHに架空のcommandを付けない。canonical本文のSHA-256で正本照合し、同eventId/hashは同receipt、別本文はconflict・元正本維持。receiptはdevice/eventId/hash/STOREDを照合し、BridgeはPUBACKで削除しない。未確認eventは機体ごと最大5件/秒・1〜8秒backoffで再送、満杯なら新操作を止める。重要な拒否・終端とoutboxを同じSQLite transactionにする。feedbackは最新1件/goal・最大1 Hzへ間引き、終端を捨てて置き換えない。

既存ACK v3はRUNNING/SUCCEEDED/FAILED/UNCERTAIN＋startedAtしか表せない。ROSの非開始REJECTEDやCANCELLEDを偽のstartedAt/FAILEDへ丸めず、bridge-eventを正本にして#194/#195でcommand実行状態・DB制約・API応答へREJECTED/CANCELLEDを追加する。旧ACK v1/v2/v3とsimulatorの成功条件は変更しない。ROS対象の実行結果をACK v3へ二重に投影送信せず、既存結果喪失の保証を改善済みと偽らない。Fleet operationの120秒結果評価と結果不明の扱いを維持し、型/集約/表示を新状態へ明示対応させる。

#194では受領ACK v2のscope検証をROS command v3へ明示対応させ、旧v1/v2 commandとの照合規則を残す。REJECTED/CANCELLEDも固定対象の分母に残し、成功数へ含めない。前goal不確定や未停止をoperation期限だけで消さず、OTA予約gateとも同じdevice排他で競合を拒否する。

server受信UTCはingestorが付ける保存metadataで、Bridgeのwire本文・canonical hashへ混ぜない。実機由来の宣言や構成digestは暗号学的な実行証明ではなく、MQTT端末認証と機体側実装を信頼する境界を残す。

更新順は、ROS対象の受付を無効→DB追加migration→`packages/protocol`とPython validator→ingestorの新形式保存/receipt→API/workerと履歴/集約の対応→Bridge/Adapterの永続領域と固定構成導入→新鮮な能力/構成報告→対象別の受付有効化とする。中断受付は#195の経路と受信側が揃うまで有効にしない。ROS非対応の既存simulator、通常Compose、OTA supervisorを変更せず共存させる。Bridgeを既存simulator用OTA bundleとして更新する機能は本Phaseに含めない。

## 10. 検証と引き渡し

| Issue      | 実ROSで確認すること／引き渡す契約                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| #190       | 固定Jazzy環境、2device namespace、topic/service/専用Action、DDS隔離、seed/障害設定、build manifest、cleanup付きsmoke test                      |
| #191       | rclpy executorとMQTTの起動・終了、購読完了前の新操作拒否、SQLite所有lock、JSON Schema共通fixture。root pnpmとは別にcolcon/pytestコマンドを定義 |
| #192       | 実publisher→Bridge→MQTT→DB/API、0/NaN/範囲外/欠測、LOCALとGPS混同拒否、sim時計逆転、QoS不適合、3秒stale、永続再送/DB receipt                   |
| #193       | 構成/能力の不変報告・desired差異・同ID別本文、REBOOT非対応、過去commandとの参照固定                                                            |
| #194       | 正常帰還・goal拒否・ABORTED・deadline、送信直前/直後SIGKILLとgoal非再投入、結果再照会/cache失効・再送・DB保存確認                              |
| #195       | cancel受付/拒否/unknown/既終端、遅延・完了競合の到着順反転、CANCELEDと停止観測欠測、同key/別本文、対象UUID限定                                 |
| #196       | MQTT切断・DDS遮断・Bridge/Action server再起動を別々に注入し、前goal不明の新操作拒否と機体側watchdog/battery/frame/policy拒否                   |
| #197〜#199 | LOCAL/欠測表示、配送/goal/実行/cancel/停止の分離、audit/介入・不明費用、実ROS/MQTT/DBの障害E2Eとデモ・削除・保証範囲                           |

mockだけをROS通信検証としない。#198では独立processを使い、Bridgeだけを止めてもserverを動かす境界と、serverのcacheを失う境界を作る。実nodeの実行回数と保存goal UUID、ROS終端、DB正本とreceiptを照合し、再接続回数や画面表示だけで重複なし/成功としない。ARM64のlocalとAMD64のCI双方でnative Linux実行を確認し、emulationの結果は別記録にする。

#189の検証は公式資料と現行コード/後続Issueとの整合、文書リンク、既存quality checkまでである。実ROS runtime、DDS到達性、QoS/timeout値、Action/cancel挙動、CPU間再現は未検証。実装前にその境界を越えた成功を主張しない。PX4/Gazebo/SLAM・制御アルゴリズム・実機・AIモデル・汎用Task評価/KPIは対象外である。後続PhaseでexecutionContextIdへ展開できる構成と証拠の関連を残すが、Task成功とROS Action成功を同一視しない。
