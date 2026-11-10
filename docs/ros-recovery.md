# ROS切断・再起動と機体側の拒否

Issue #196。[実行journal](ros-command-journal.md)と[中断追跡](ros-cancellation.md)に加え、通信・観測・未解決goalを独立した証拠として扱う。再接続は実行完了でも停止証明でもない。

## 障害と復旧境界

| 障害 | BridgeとCloudの扱い |
| --- | --- |
| MQTT切断 | 新規送信を止め、既存goalのROS照会・機体側heartbeatと制約検査は継続する。結果・重要eventはSQLiteへ保存し、DB receiptまで再送する |
| ROS node喪失 / DDS通信断 | MQTTがONLINEでもROS_UNAVAILABLEとし、新規操作を拒否する。観測だけで原因を断定せず、故障注入の種類は試験記録に残す |
| Bridge再起動 | 同じjournal・goal UUID・server/configを照合し、GetResultだけを再照会する。新しいUUIDやSendGoalで穴埋めしない |
| Action server再起動 | 起動UUIDの変更をSERVER_CHANGEDとしてUNCERTAINにする。前世代の成否・停止を推定せず、予約を残す |
| 結果保持切れ / 応答なし / 保存不能 | 予算内の照会で取得できなければUNCERTAIN。履歴を捨てたり、DBを再初期化してreadyへ戻したりしない |

GetResultは同じgoalへ同時1件、1回2秒、1〜8秒backoff、最大5回/最初の照会から30秒で打ち切る。回数・最初のUTCは再起動しても戻さない。結果の元期限はAPI受付から120秒。参照serverのresult cacheは既定900秒・最大900秒で、process再起動時は失う。期限だけから実際のcache消失や成否を推定しない。

起動直後やROS不通でserver/configを照合できない間はGetResultを送らない。照会済みの30秒予算や元120秒期限は延長しない。UNKNOWN応答にはserver UUIDがないため、応答後の新しいruntime照会で世代を再確認してから理由を確定する。世代が変わればSERVER_CHANGED、同じ世代で取得不能ならRESULT_UNKNOWN / RESULT_CACHE_UNAVAILABLEとし、いずれも停止成功や再投入へ読み替えない。

前goalが継続し得る間、CloudとBridge、参照機体の三層で新操作を拒否する。終端が得られても停止観測が欠ければ予約を残す。停止観測は同じserver/goal/config、終端後5秒以内、新鮮なIDLE・速度0.05 m/s以下の1秒継続を必要とし、遮断前の観測や単なる速度0で補完しない。後着結果は保存しても元期限内の成功へ書き換えない。

## 接続と引き継ぎの記録

Bridge 0.5.0はbridge-events v1の`ROS_HEALTH`を、状態変化時と同状態の5秒ごとにSQLiteへ保存する。device/event/session/journal/sequence/config、現在照会できたserver UUIDまたはnull、MQTT接続/購読、ROS到達性、観測鮮度、ready、機体理由、未解決command/goal・照会回数・元期限・人間判断要否、telemetry欠損件数と上限を分ける。架空のcommandIdや物理停止証明は付けない。

ingestorは`bridge_health_events`へ原文・canonical hash・採否・受信UTCをcommitしてからreceiptを返す。同ID同本文は同receipt、別本文や別kindとのID衝突は元正本を維持して衝突記録を残す。UPDATEは禁止する。現在のjournal/configに対応しない、15秒以上時計がずれる、古いsequenceの報告は復旧の正本へ昇格しない。

`GET /devices/:deviceId/bridge-health?limit=100`は最新の採用記録、fresh/ready、人間判断要否と件数制限付き履歴を返す。送信UTCと受信UTCの両方が15秒未満であることを必要とし、古いoutboxが再到着しても復旧済みにしない。Bridge 0.5.0の新規commandには新鮮なready報告と現在server UUIDの一致も必要とする。旧0.3.0/0.4.0の実行・中断契約は維持する。

`GET /commands/:commandId/bridge-execution`の`recovery`は、保存済みの結果不明・矛盾・終端後5秒を過ぎた停止未確認を人間へ引き継ぐ。停止観測を正常に待つ最初の5秒は人間対応必須としない。証拠event、RESULT_DEADLINE / EVENT_CONFLICT / STOP_UNCONFIRMED等の理由、`automaticResubmit=false`、`RECONCILE_EVIDENCE_AND_INSPECT_DEVICE`を返す。接続復帰でこの判断を解除せず、実機・保存証拠・機体側制約の確認を求める。本Issueは安全性を確認できない予約の強制解除APIを作らない。

接続理由・判断要否の変化は`bridge.health_changed`として既存auditへ記録し、未解決commandがあれば関連付ける。これはsystemが記録した引き継ぎ要求であり、操作者の本人認証や作業開始/終了ではない。作業完了時刻・人間の所要時間・費用は未報告nullのままとする。OTA専用の介入へ混在させない。専用ROS画面は#197の範囲。

## Cloudに依存しない機体側制約

参照Adapter 0.4.0は許可frame/home・構成・owner、開始/実行期限、同時goalなし、batteryが有効かつ20%以上、sensor age 3秒未満、homeから10 m以内を検査する。実行中も10 Hzで検査し、heartbeatが3秒途絶すればBRIDGE_WATCHDOG、battery低下・sensor欠測・領域外はそれぞれLOW_BATTERY / SENSOR_STALE / POLICY_REJECTEDでABORTEDにする。Cloud/MQTTやAIの許可で解除する経路は持たない。

goal拒否のboolだけから詳細理由を推定しない。新しい`GetGoalDecision` serviceは同じgoal UUID・server/configの拒否理由を照会し、Bridgeが最大2秒・1回だけ照合してGOAL_REJECTEDの`adapterDecision`（reason、CDR、hash）へ保存する。照合不能ならACTION_REJECTEDだけを残す。参照側の拒否理由は直近100 goalに制限し、同goalの先着理由を固定する。server再起動・退避で失うため、永久的な拒否履歴ではない。許可済みcommandの重複台帳は最大10,000件で、自動削除しない。

これは同じ参照process内のモデル更新停止と拒否ロジックである。process自体の停止、host故障、motor制御、独立ハードウェアの緊急停止、安全認証、実機の物理安全停止は保証しない。確かなABORTEDでも停止観測とは別の証拠である。

## 上限と運用

MQTT入力queueは最大100件・1packet 32 KiB、再接続は1〜8秒backoff。重要journalは最大10,000件/32 MiBの論理本文量で、履歴・未確認eventを消して空きを作らない。満杯・書込不能なら新規操作とheartbeatを止め、保存できない停止を成功扱いしない。DB/WAL/indexの物理容量は別途必要。telemetryは別の有界outboxで古い観測を退避し、`telemetryDropped`へ欠損件数を記録する。長期切断で欠損なしの保証はなく、障害時間だけで保持件数を保証しない。

更新はROS受付停止→migration 0025→protocol/ingestor/API→interfaces/Adapter 0.4.0とBridge 0.5.0→新鮮な構成/health確認の順に行う。既存SQLite schema 7とそのUUID/履歴を維持し、volume再初期化は不要。AWS topic/Policyは変更せず、実AWSでは検証しない。

## 検証

`ROS_COMMANDS_CASES=recovery corepack pnpm test:ros-commands`で障害ケースだけを実行できる。既定の`corepack pnpm test:ros-commands`は通常Action・中断も含む。参照制約は`corepack pnpm test:ros-reference`、Bridgeの永続・有界処理は`corepack pnpm test:ros-bridge`でも検証する。

検証用ComposeだけDDSをUDPへ固定し、Bridgeの試験用preloadでUDP packetを遮断する。Jazzyの[rmw実装](https://github.com/ros2/rmw_fastrtps/blob/jazzy/rmw_fastrtps_shared_cpp/src/participant.cpp)はLOCALHOST指定時にSHM transportも追加する。そのため試験だけSYSTEM_DEFAULTと[loopback whitelist](https://fast-dds.docs.eprosima.com/en/2.14.x/fastdds/transport/whitelist.html)・localhost peerの固定XMLを組み合わせ、SHMで迂回しない構成にする。Bridgeの例外許可はBRIDGE_INTEGRATION=trueと固定XML pathの組合せに限定し、通常起動はLOCALHOST以外を拒否する。

TCP/MQTTと参照機体processは生かし、host firewallや実機に触れない。遮断fileは専用volume内だけで、BRIDGE_INTEGRATION=trueのときだけ有効。通常Composeにはpreloadを設定しない。試験supervisorのHUPは参照子processを強制終了・再生成し、Bridgeとnetwork namespaceを維持してresult cache/世代喪失を作る。通常の参照起動にはsupervisorを使わない。

故障前後の実受理/実行回数、元goal UUID、CDR/hash、DB正本、health採否とcleanupを保存する。MQTT切断中の成功/LOW_BATTERY、DDSのみの遮断、node喪失、Bridge再起動、Action server世代変更を別ケースとし、欠測を復旧完了へ短絡しない。実行済みの環境・件数はPRへ記録する。
