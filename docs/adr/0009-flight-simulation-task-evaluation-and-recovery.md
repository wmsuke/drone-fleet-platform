# ADR 0009: 飛行シミュレータとTask評価・復旧の境界

- 状態: 採用。#220では構成選定の起動試験と設計を確定する。製品用環境・Adapter・Task機能は#221〜#231で実装する
- 決定日: 2026-11-24
- 対象: [Phase 7 #219](https://github.com/wmsuke/drone-fleet-platform/issues/219)、[Issue #220](https://github.com/wmsuke/drone-fleet-platform/issues/220)
- 前提: Phase 6 #188は完了、レビュー修正#218はmain `b54a135`へマージ済み。[ADR 0008](0008-ros2-bridge-contract-and-recovery.md)と現行のcommand / receipt / cancel / 排他を維持する
- 計画: [Task評価・Physical AI計画](https://app.notion.com/p/3fe512303eae818cb481e62a47ed9c42)。当初の状態候補を本ADRで具体化する。AI・KPIの全面実装を追加しない

## 1. 構成選定

Ubuntu 24.04 / ROS 2 Jazzy / Fast DDS / Python rclpyを維持し、**Gazebo Harmonic、標準MulticopterVelocityControl / MulticopterMotorModel、X3モデル、ros_gz_bridge**を採用する。Gazeboの物理エンジンがローター推力と機体運動を計算する。姿勢・速度制御は既存pluginへ任せ、Platformで制御器・推定器を開発しない。帰還のための有限な目標位置→速度指令のAdapterを#222で追加する。これはautopilotのRTL・着陸・実機制御を検証する構成ではない。

2026-11-24に公式資料を確認した。比較対象をすべて動作検証したという意味ではない。

| 候補                    | version / OS・CPU / ROS接続                                                                                                                     | 資源・追加責務と判断                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gazebo単独multicopter   | Harmonic gz-sim **8.15.0**、ros_gz **1.0.25**、Noble / Jazzy。今回Linux arm64で実起動。amd64は公式Jazzy配布対象、製品固定imageの両CPU検証は#221 | 1機・描画/画像sensorなしで検証可能。ROSとの境界はros_gzだけ。採用。ground truth制御であり実機推定器の評価には使わない                                                                             |
| PX4 SITL + Gazebo       | 比較対象v1.18.0。公式にNoble/Jazzyとamd64/arm64の配布経路がある。uXRCE-DDS / px4_msgs等が必要                                                   | autopilotのmode、arming、failsafeも試せるが、firmware・message版整合とAgentが増える。今回は起動/性能を未測定。Phase 7のTask評価に必須ではないため不採用。将来採用時は別Adapter/ProfileとADRを作る |
| ArduPilot SITL + Gazebo | 比較対象Copter-4.6.3、ROS接続はAP_DDS / micro_ros_agent。現行masterのROS手順はHumble/Jazzy両方を案内                                            | firmware・Gazebo plugin・DDS Agentの整合が必要。古いWikiの「Humbleのみ」と現行sourceの差があり、Copter-4.6.3のJazzy/両CPU組合せは未検証。非対応とは断定せず、今回の採用を見送る                   |

選定理由は既存Jazzyとの整合、少ない通信境界、localとGPUなしheadless CIでの検証可能性である。3候補の性能比較や安全性の優劣を示すものではない。公式の[ROS/Gazebo対応表](https://gazebosim.org/docs/harmonic/ros_installation/)はJazzy＋Harmonicを推奨し、[vendor packages](https://gazebosim.org/docs/harmonic/ros2_gz_vendor_pkgs/)経由で導入できる。既存のROS固定imageへapt installせず、別imageで導入する。

選定試験の[再現手順・実測・失敗記録](../experiments/gazebo-selection/README.md)と[result](../experiments/gazebo-selection/result.json)を残す。上昇・hover、ROS指令/odometry/clock、正常終了を確認する最小試験であり、Fleet接続・Task成功・衝突・battery・両CPUのE2Eを確認済みとはしない。

### 固定環境とheadless CI

#221で別の`flight-sim` build context / image / Compose profileを用意する。`ros/Dockerfile`、`ros/locks`、Phase 6の専用check、通常simulator/OTAを維持する。Gazebo・ros_gzを入れると共通ROS debが更新され得るため、既存参照環境へ上書きしない。

- Noble/Jazzy、gz-sim 8.15.0、ros_gz 1.0.25を基準とし、両CPUのOCI digest・全deb完全version/hash・plugin/physics・Python依存・source revisionをmanifestへ固定する。tagやaptの現在候補だけで再現可能とはしない。取得できない版は別版として再検証・ADR更新する。
- X3 Fuel model revision 4とworldの固定revision、全資産hash・ライセンスを保存する。実行時のFuel取得、apt/pip/rosdep更新、`main`追随を禁止する。選定試験のapt取得は製品環境の固定完了ではない。
- 1機、CPU物理、1 ms step、seed・初期pose・障害時刻固定、camera/LiDAR/GUIなしの`gz sim -s -r`を使う。`--headless-rendering`は描画sensor用EGLであり、今回は不要。画像sensor導入時にGPU/rendererを再検討する。
- Gazebo / ros_gz / Adapter / Bridgeを別process・同一専用network namespaceに置く。DDS LOCALHOST、domain 43、GZ_PARTITIONを試験ごとに分離し、外部port・host networkを使わない。Gazebo TransportをLANへ公開しない。
- CIはnative Linux amd64、localはnative Linux arm64。emulationをnativeの成功に数えない。両CPUの既知scenarioを通してから#221完了とする。初期予約は4 vCPU・8 GiB・空き20 GiB、1 job/1機。これは開始時の資源予算で、最低動作要件や性能保証ではない。
- real-time factor低下を想定し、sim時間・wall時間・CPU/peak memory・image容量を別記録する。30秒起動/30秒終了・1回のTask最大300秒wall・E2E job最大20分とし、sim時間が進まなくてもwall期限で終了する。無制限待ちや固定sleepだけのready判定をしない。
- process生存だけでreadyにせず、clock前進、fresh odometry/battery/contact monitor、Profile/config/home/世代整合を照合する。失敗時もログ・manifest・reportを保存し、専用container/volume/network/imageのcleanup残存を検査する。

## 2. 初期Taskと機体側契約

初期Taskは1種類の`RETURN_HOME`。既に飛行準備された1機が、登録済みの空中homeへ戻ってhoverする。離陸準備はscenario fixtureの別操作として記録し、Task実行時間や成功へ混ぜない。自動着陸・disarm、任意waypoint列、複数機協調、REBOOTは対象外とする。

| 項目       | 初期仕様（#222〜#225で実装）                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 座標       | LOCAL ENU、右手系、m/m/s/rad/s。`fleet/d_<hex>/map`は固定world座標、bodyはbase_link。GPS/NEDへ読み替えない                                                                                                                                                           |
| frame変換  | 選定試験の元odometryは`x3/odom` / `x3/base_footprint`。#222でmodelの固定transformを明記し、pose・twistそれぞれのframeとyawを変換して既存map/base_link契約へ渡す。単なる文字列置換やworld速度をbody速度として送る処理は禁止                                           |
| home       | world起動後、fixtureのfreshかつ安定したposeから明示登録する。例はworld (0,0,1)m。homeId・pose・frame・worldInstanceIdを固定し、実行中は変えない。world再生成/reset後は無効化して再登録する                                                                           |
| mode       | `SIM_VELOCITY_CONTROL`をProfileへ定義。RETURNING_HOME中のcancel/制約違反は許可領域内でのHOLDへ移る。controller disableは墜落し得るので停止手段にしない。hoverを既存IDLE（着地）へ投影せず、legacy flightStatusはUNKNOWN、sim専用stateでHOLD/RETURNING_HOMEを報告する |
| 開始条件   | fresh clock/pose/velocity/battery/contact stream、既知home/frame/構成、heartbeat、時刻同期、battery 20%以上、homeから10m以内、z 0.5〜3m、既存command/OTAと排他、未解決goalなし。準備時はhome誤差0.5m以上の既定start poseを使い、既にhomeにいる試験と分ける           |
| 運動制約   | 最大速度0.5m/s、加速度1m/s²、home半径10m・z 0.5〜3m、body/world変換を伴う。値はsim試験用。実機の安全値ではない                                                                                                                                                       |
| 機体側制約 | 10 Hz以上でfreshness・battery・領域・衝突・mode・期限・heartbeatを検査。観測age 3秒、heartbeat断3秒で新指令拒否/HOLDを要求し、停止は別観測。Cloud/MQTT切断でも機体側が維持する。process停止時に成立する独立ハードウェア安全は保証しない                              |
| battery    | GazeboのLinearBatteryPluginと固定負荷/容量設定を用い、BatteryStateへ変換する。消費モデル・初期値・注入条件をcontextへ固定。電池未取得を100%に補完しない。電気/実機battery精度は保証しない                                                                            |
| Action     | 既存ReturnHome Actionのgoal/結果/UUID・開始期限30秒・結果期限120秒を再利用する。実行上限60秒wall。別のsimulation Profile/Adapter versionを登録し、既存reference_vehicleの意味・閾値を変えない                                                                        |

初期の到達許容誤差は3D距離0.20m以下、速さ0.05m/s以下、**sim時間で連続1秒**、観測間隔0.2秒以下（期待10Hz）とする。wall時間にも3秒のfresh制約を課す。Actionは機体側の到達判定を返すが、Cloudは別の評価証拠を照合する。着陸・物理停止の代わりにHOLDでの並進速度とyaw rate（0.05rad/s以下）を観測し、同goal/server/configに結ぶ。Phase 6のIDLE必須停止Profileは流用せず、Profile適合gateも#222で更新する。

## 3. Task・attempt・評価・構成の単位

各IDはUUID v4を生成し、hashはcanonical JSONのSHA-256とする。距離/時間などの定義値はmm/ms等の整数で固定し、元観測floatは証拠として保持する。

| 単位 / 識別子                          | 不変に保持する内容と状態                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task / taskId                          | deviceId、RETURN_HOME、home・成功/失敗条件、evaluatorRef、recoveryPolicyRef、受付UTC・deadline、Idempotency-Key/本文hash。状態はQUEUED → RUNNING → EVALUATING → SUCCEEDED/FAILED/CANCELLED、回復待ちはRECOVERING、人間待ちはWAITING_FOR_HUMAN                                                                         |
| Execution Attempt / attemptId          | taskId、attempt番号、前attemptId、commandId（1対1）、元goal UUID（既知なら）、server世代、executionContextId、開始/結果期限。PREPARED → DISPATCHING → RUNNING → EVALUATING → SUCCEEDED/FAILED/CANCELLED/UNCERTAIN。非開始拒否はREJECTED。配送/ACK/goal状態は既存commandの別軸                                         |
| Evaluation / evaluationId              | attempt/context、evaluator ID/version/digest、証拠一覧/hash・対象範囲・watermark、評価UTC、各predicateのPASS/FAIL/UNKNOWN。集約はSUCCEEDED/FAILED/CANCELLED/UNCERTAIN。再評価はsupersedes付きの新行、過去行を上書きしない                                                                                             |
| Execution Context / executionContextId | expectedとreported/appliedの区別、Bridge/Adapter/runtime・image/source/plugin/physics/model/world/seed/scenario、Profile・安全設定・運用/復旧policy・evaluator、home/frame、worldInstanceId/clockEpoch、実使用構成報告eventとconfigurationId。AI非使用はmodelRefs=[] / NOT_APPLICABLE、未知versionはUNKNOWNで開始拒否 |
| Recovery / recoveryId                  | 原因event/evaluation、前attempt、許可理由、予約した予算と次attempt、deadline。PENDING → CHECKING → RETRY_RESERVED → VERIFYING → RECOVERED/EXHAUSTED/REJECTED/UNCERTAIN。回復成功は次attemptの目的達成まで必要                                                                                                         |
| Intervention / interventionId          | task/attempt/recovery、種類（REQUIRED_APPROVAL / FAULT_HANDOFF / MANUAL_ACTION / CANCEL）、reason・actor、要求/開始/終了UTC、結果。REQUESTED → IN_PROGRESS → RESOLVED/ABANDONED。未認証actorと未報告時間・費用はnullを維持                                                                                            |

Taskの不確定は`WAITING_FOR_HUMAN`＋`outcome=UNCERTAIN`で表し、最終FAILEDや停止済みに潰さない。SUCCEEDED/FAILED/CANCELLEDの完了Taskは自動再開しない。後着証拠や人間の照合は追記評価・auditとして残し、過去の期限内成功や自律成功へ書き換えない。

#223で受付と対象予約・最初のPREPARED attempt・command/outbox対応・auditを同じDB transactionへ保存する。初期Task deadlineは受付から300秒wall、同deviceはTask/command/OTA共通予約1件。queuedのまま期限を過ぎた未送信attemptは非開始FAILEDで閉じ、送信可能性があればUNCERTAINと排他を維持する。HTTP 202・MQTT ACKをRUNNING/成功へ昇格しない。

予約はreservationId（UUID）とdeviceごとの永続増加fenceを持ち、workerのstate更新・予算消費・次attempt/outbox生成は現在fenceとの比較更新で行う。古いworkerは新しいattemptを作れない。fenceはCloud DBの競合防止で、ROSへ未送信のtokenを機体が検証したとは主張しない。遅着した既存outboxは同command/元期限のまま照合し、Bridge/Adapterの永続重複抑止と未解決goal排他を維持する。journalの喪失をCloud fenceだけで安全に回復できるとは扱わない。

#224で受付時のexpected contextを保存し、実開始feedback/resultと報告構成からapplied contextを不変にbindする。実開始前に構成を照合できなければ送らない。非開始REJECTEDにstartedAtやapplied contextを作らない。再試行では新attempt/contextを作り、definitionが同じでも履歴の関連を独立させる。UNKNOWN・同ID別本文・古い報告は拒否して介入へ渡す。

### crashと排他

| 停止境界                                  | 再起動・復旧時の扱い                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Task受付commit前                          | 同key/同本文で再受付。同key/別本文は409。未commitのIDを受理済みにしない                                                             |
| commit後、BridgeのSEND_INTENT前           | 永続outboxから同じcommandを元開始期限内に再送可能。attempt/command/goalを新しくしない                                               |
| SEND_INTENT後、ROS応答保存前              | 既存journalの元UUID照会だけ。UNCERTAIN、予約保持、新goal禁止。DB transactionやCloud leaseでROS副作用まで原子化したと扱わない        |
| result / evidence保存後、receipt前        | 元eventId/hashを再送し冪等保存。PUBACKでは削除しない。受信UTCは再送時も元発生時刻を置換しない                                       |
| 評価/復旧予約transaction中                | evaluationの一意keyとTask revisionをlockし、予算消費・次attempt/context・outboxを同時commitする。worker再起動で回数・期限を戻さない |
| lease失効・disk消失・server/world世代変更 | 停止証拠ではない。未解決予約を保持しWAITING_FOR_HUMAN。journal再初期化・TTL・新Taskで操作を再開しない                               |

Taskの期限とcommandの結果期限は延長しない。monotonicは同process内のtimeout、UTCは永続deadline、sim clockは物理経過/滞在の評価に使う。再起動時は元UTC期限へ戻し、時計不信は新操作を拒否する。Taskの予約をcommand終端だけで外さず、評価確定・停止確認または人間による証拠照合が揃うまで保持する。

## 4. 成功・失敗・不確定と復旧許可

優先順は識別子/世代/conflict検査 → 確かな失敗制約 → 完全な成功/中断証拠 → 欠測時UNCERTAIN。確かな衝突を後の到達で打ち消さない。結果不明と実行失敗を混同しない。

| 観測・条件                                                                                                                                                      | attempt評価 / Task状態                                            | 自動復旧                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| 同goal/config/contextのSUCCEEDED result、開始〜終端まで証拠連続、home誤差/速度/yaw rateの1秒滞在、正常battery/mode、制約違反・衝突なし、停止/HOLD確認、元期限内 | SUCCEEDED / SUCCEEDED。人間介入ありは介入あり成功として保持       | 不要                                                                |
| Action SUCCEEDEDでも目的地外・滞在不足が確かな連続観測で確認された                                                                                              | FAILED / FAILED。ACTION_TASK_MISMATCH                             | 禁止。Adapter/evaluatorの不整合を人間へ                             |
| 衝突、領域/高度/速度制約違反、LOW_BATTERY、非対応能力、構成不一致                                                                                               | FAILEDまたは非開始REJECTED / FAILED（停止不明なら人間待ちも保持） | 禁止。battery回復や再接続だけで解除しない                           |
| 新鮮な進捗が10秒sim改善しない（home距離の改善0.1m未満）かつwall30秒以内にも進捗なし。機体側がSTALLEDで終端しHOLDを確認                                          | FAILED / RECOVERING候補                                           | 下記の全許可条件成立時だけ1回。障害物・衝突・禁止領域が理由なら禁止 |
| 明示的な非開始TEMPORARY_NOT_READY（理由と非開始証拠が照合済み）                                                                                                 | REJECTED / RECOVERING候補                                         | fresh/readyと停止・予算を再検証。期限切れ・未知rejectは対象外       |
| cancel受付のみ、result欠落、停止観測欠落、古い/欠測/矛盾する証拠、sim停止/reset、server喪失                                                                     | UNCERTAIN / WAITING_FOR_HUMAN                                     | 禁止。元goal照会と証拠照合。再接続を復旧成功にしない                |
| 同goalのCANCELED終端＋fresh HOLD/停止証拠、かつ成功証拠が先に確定していない                                                                                     | CANCELLED / CANCELLED                                             | 禁止。人間の中断を自動で取り消さない                                |
| 先に確定した成功/失敗と後着cancel要求が競合                                                                                                                     | 元の確定結果を保持、cancel履歴と評価を追記                        | 新attemptを作らない                                                 |
| Task/attempt期限到達、確かな失敗終端・停止あり                                                                                                                  | FAILED / FAILED（BUDGET_EXHAUSTED）                               | 禁止                                                                |
| Task/attempt期限到達、実行中かもしれない                                                                                                                        | UNCERTAIN / WAITING_FOR_HUMAN、機体側HOLD要求と停止追跡           | 禁止。期限で予約を解放しない                                        |

自動再試行は初期policy `flight-return-home-recovery/1.0.0`へ固定し、**Taskあたり追加1 attemptまで（合計2）**、待機5秒wall、回復処理最大120秒wall、Task全体300秒wall、次commandの120秒結果期限を収容できる残量を必須とする。予算はDBへ先に消費予約する。許可reasonは`TEMPORARY_NOT_READY`と`STALLED`だけで、後者は機体側の確かな終端理由が必要。期限や推測した進捗停止だけで再試行しない。

全許可条件は、前attempt終端＋停止/HOLD確認、未知/active goalなし、freshなpose/battery/contact/clockと同world/home、排他所有と構成一致、残り回数/時間/費用枠、操作者の取消なし、障害要因解消の観測である。1つでもUNKNOWNならWAITING_FOR_HUMAN。前attemptのcommand/goalを配送再送する処理と、新attempt/command/goalでやり直す処理を分ける。

Phase 7の自動復旧はlocal限定・外部有料APIなしとし、policyのcloud/API費用枠を0（外部利用禁止）へ固定する。実測費用が0という意味ではない。local compute/電力/人件費は取得できなければnull。AWSでの復旧は既定無効とし、別途#64の残量・料金・件数/時間上限と明示承認を満たさない限り開始しない。

人間は証拠参照付きで対応開始/判断/終了を記録する。停止を確認できないまま予約を強制解除するAPIは作らない。照合で解決できない場合はWAITING_FOR_HUMANを保持する。手動操作後に再実行する場合は旧Taskを履歴として残し、確認済み停止・再登録構成から新Taskを明示受付する。元Taskの自律成功へ算入しない。

## 5. 評価証拠・時計・障害scenario

telemetry v3の約1Hz snapshotだけでは0.2秒以下の連続性や衝突なしを証明できない。#222でsim側の10Hz以上の観測を連番付きで集め、1秒ごとのbatch（最大20 sample、32KiB以内）とwatermarkへ永続化する。受信できたsampleだけを分母にして欠測を隠さない。

各sampleはworldInstanceId、clockEpoch、sourceSequence、sim stamp、pose/twist/frame、battery、mode、制約、contactを持つ。batchは取得範囲・期待/実sample数・欠損/overflow、contact monitorの生存・全physics step監視の到達watermark、発生UTC/受信UTC・eventId/hashを保持する。生のcontactが出た時だけでなく、監視が生きて衝突0だった区間も記録する。開始前からresult/停止後までのwatermarkが閉じるまで成功へ確定しない。contact監視欠落・queue overflow・未配送はUNKNOWNとなる。

| scenario                                | 再現・観測方法 / 評価                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常帰還                                | 固定start pose/home/seed、実ローター推力とodometry、Action result・HOLD・証拠範囲を照合。Action成功単独では不可                                                                                   |
| 指令受理したが動かない / 目的地外で停止 | 故障設定で推力/速度入力を抑止し、poseと進捗・終端・停止を実測。成功resultの偽装fixtureと実物理故障を区別する                                                                                      |
| sim pause / 欠測 / timestamp重複        | `/clock`とtopic受信のmonotonic ageを監視。sim pauseはwall deadlineを止めず、同stamp再送で滞在を延長しない。新windowを待つだけで不明なattemptを再投入しない                                        |
| sim reset / 逆転 / 大jump               | world UUID・clockEpochを更新しhome/contextを無効化する。active goalがあればserver世代も更新してUNCERTAINに固定。reset前後のsampleを同じ滞在windowへ連結せず、旧goalを再投入しない                 |
| 衝突                                    | 接触sensor/Contact systemが機体collisionと固定障害物/床の組を記録する。初期fixtureの床接触とTask開始後の接触を区別。Task中の床/障害物接触は失敗。薄い障害物の接触を低Hz telemetryだけで判定しない |
| 障害物による停滞                        | digest付きworldに固定boxを配置し、位置・速度・contact・constraint reasonを記録する。接触と非接触停滞を区別。到達だけから回避成功を推測せず、回避planner自体は実装しない                           |
| 通信/プロセス断                         | MQTTだけ、DDSだけ、Adapter/Bridge/Gazeboの各停止を別caseにする。元command/goal、同server照会、終端/停止と実受理・実行数を照合。PUBACKや再接続回数で成功にしない                                   |

開始・結果・停止・証拠のworld/clock/goal/config/context対応が崩れたら成功不可。確かな制約違反がなければUNCERTAINであり、欠測をFAILEDとして自動再試行可能にしない。遅延batchは同event/hashで保存し、元のsource/発生時刻を維持する。期限後に揃った証拠は追記評価にし、期限内成功の統計を変えない。

## 6. migration・通信契約と更新順序

本Issueではmigrationやwire schemaを追加しない。以下は後続Issueの実装契約であり、現在のAPI/topicとして公開しない。

| 領域           | 変更予定 / 維持する境界                                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #223 DB/API    | tasks、task_attempts、task_events、task_evaluations、task_recoveries、task_interventionsとoutbox/共通device予約を追加。UUID外部key・attempt番号/command対応・評価keyを一意にし、definition/context/評価/eventを不変にする。既存command/OTA予約と同device lock順を共有 |
| #224 context   | task_execution_contextsへexpected/appliedと各定義・snapshot・報告eventを保存。各attempt・evaluationからFK参照。既存bridge_configurationsを参照して再利用し、過去のROS commandを架空Task/contextへbackfillしない                                                       |
| protocolの正本 | `packages/protocol`にTask入力・状態・評価predicate・reason・context・証拠batchを定義し、Python JSON Schema/fixtureとhashを生成。ROSのframe/clock/相関/期限の意味検証も共通fixtureへ追加                                                                               |
| ROS接続 #222   | simulation専用Adapter/Profile、clock/contact/batteryと型付きSimulationEvidenceを追加。ReturnHome/CancelGoalの識別・期限・対象goal指定は維持。world resetをruntime世代変更として報告。起動UUID等が整合しないserverをreadyにしない                                      |
| MQTT #222/#224 | 既存bridge-eventsに**schemaVersion 2**を追加しSIMULATION_EVIDENCEとsimulation構成の型を明示する。旧v1の既知version/型へ未知fieldを混ぜない。event共通identity/hash・bridge-receiptsのDB保存確認を維持する。証拠batchの更新不能・再送・同ID別本文conflictを検証        |
| command        | command v3/受領ACK v2と既存のROS event v1を維持。Task/attempt/command対応はCloud DBに持ち、goalを再利用しない。新simulation構成/health gateは明示version対応として追加し、旧Profileで有効化しない                                                                     |
| 停止・画面     | simulationのHOLD/mode・yaw rateを新形式で報告し、既存IDLE停止証拠へ偽装しない。#228でTask評価とAction/cancel/停止を別表示。旧画面/APIにはunsupportedを返し、成功へ補完しない                                                                                          |
| 権限/容量      | 新topicは作らず既存の自機bridge-events/receipts scopeを維持。payload32KiB・重要journal10,000件/32MiBを維持し、評価証拠は通常telemetryの最古破棄へ混ぜない。満杯/未確認で新操作停止、欠損を評価へ反映する。AWS適用は本Phaseのlocal検証から分離                         |

更新順は対象Task受付無効 → DB追加migration → protocol/共有fixture → ingestorのv2冪等保存/receipt → API/評価/履歴 → simulation固定環境とAdapter/Bridge → fresh構成/health/evidence確認 → 対応対象だけ受付有効とする。旧simulator・reference_vehicle・OTAは維持する。中断/復旧は各gate・履歴保存・停止証拠が揃うまで無効。旧受信側が新schemaを拒否する混在期間に新操作を流さない。

rollbackはまず新Task受付を止め、active/不明なattemptの停止・結果を照合してからサービスを戻す。未確認outbox・journalと追加DB行を削除せず、旧版へdrop migrationしない。未解決予約がある機体は旧command/OTAでも開始不可とする。詳細migration番号やcomponent versionは各実装Issueで実際のchainを確認して割り当てる。

## 7. 試験と引き渡し

| Issue      | 完了時に確認すること                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| #221       | 固定image/資産・両CPU native・headless起動/終了・clock/物理/初期状態・seed/障害設定・資源とcleanup。今回の選定試験を製品環境へ固定する      |
| #222       | 実Gazebo↔ROS↔Bridge↔MQTT↔DB/API。frame/単位/clock、battery/contact/HOLD、実帰還・制約拒否・cancel/停止、新旧schema/Profileの共存            |
| #223〜#224 | 同key/別本文、競合受付、Task-command-OTA共通排他、crash/outbox、expected/applied、更新後の履歴不変、未知/衝突構成の拒否                     |
| #225       | 本ADRの評価表を正常/異常/欠測/逆順/重複fixtureで検査し、実物理scenarioの証拠でも照合。Action成功＋目的未達を成功にしない                    |
| #226〜#227 | 許可失敗と停止/HOLD・予算・再起動を通した追加1回上限、UNCERTAIN非再投入、cancel競合・人間判断/作業履歴・未報告費用null                      |
| #228〜#231 | 状態/評価/証拠/構成/介入の画面、実Gazebo故障E2E、Task固定分母とattempt別結果、デモ・削除・保証範囲。全必須caseと未実行数・cleanupをreport化 |

Phase 6の実DDS/Action/cancel/journal/receipt/構成snapshot/healthと34ケースの回帰を再利用する。旧33ケースの歴史的記録は変更しない。Phase 7専用caseをmockのみで完了扱いせず、別のGazebo実物理E2Eとして加える。継続障害試験はlocal、AWSを実施する場合だけ#64の条件を適用する。

Phase 7.5 #212の実機・DDSネットワーク/認証・pilotの緊急停止・hardware watchdog・実機安全評価、Phase 8のAI/model registry・学習・総合KPIダッシュボードは対象外。Task試験の件数・時間・介入の集計#230は含むが、AI効果や実機への技能移植の証明にはしない。

## 参照資料

- [Gazebo Harmonic対応OS](https://gazebosim.org/docs/harmonic/install_ubuntu/)、[ROS/Gazebo対応](https://gazebosim.org/docs/harmonic/ros_installation/)、[描画sensorのheadless/EGL](https://gazebosim.org/api/sim/8/headless_rendering.html)
- [MulticopterVelocityControlのbody frame・推力と無効化の意味](https://gazebosim.org/api/sim/8/classgz_1_1sim_1_1systems_1_1MulticopterVelocityControl.html)、[公式world固定revision](https://github.com/gazebosim/gz-sim/blob/a7f89720bbcb1a5191e4eb53917fef048c26740c/examples/worlds/multicopter_velocity_control.sdf)
- [ros_gzの型対応（固定revision）](https://github.com/gazebosim/ros_gz/tree/98b83c5a075f350c143b3b403fc4482ebed180c0/ros_gz_bridge)、[PX4 v1.18配布・CPU構成](https://docs.px4.io/v1.18/en/simulation/px4_sitl_prebuilt_packages)、[PX4 ROS 2接続](https://docs.px4.io/main/en/ros2/user_guide)
- [ArduPilotのROS手順（確認時revision）](https://github.com/ArduPilot/ardupilot/blob/d4d8a7d1e32ae497d933d6f9989a6334d992fc54/Tools/ros2/README.md)、[Gazebo連携手順](https://ardupilot.org/dev/docs/ros2-gazebo.html)。masterの手順と選定対象releaseの対応を同一視しない
- [現行ROS観測](../ros-observations.md)、[構成固定](../bridge-configuration.md)、[Action journal](../ros-command-journal.md)、[中断](../ros-cancellation.md)、[切断復旧](../ros-recovery.md)、[Phase 6 E2E](../ros-e2e.md)
