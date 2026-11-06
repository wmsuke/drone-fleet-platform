# ROS commandの実行・保存と復旧

Issue #194。APIのRETURN_HOMEを参照ROS Actionへ渡し、受領・goal受付・feedback・終端・停止観測を別の証拠として保存する。実機制御、cancel API、汎用Task評価は含めない。[ADR 0008](adr/0008-ros2-bridge-contract-and-recovery.md)の責務・復旧境界を維持する。

## 通信契約

`packages/protocol`の`rosCommandMessageSchema`で専用command v3を定義する。`RETURN_HOME`、`targetKind=ROS2`、構成snapshotの`expectedConfigurationId`、受付UTCから30秒の`expiresAt`、120秒の`resultDeadline`を必須にする。未知のActionやREBOOTを受け付けない。Python向けJSON Schemaを同じ定義から生成する。JSON Schemaへ変換されない期限の相関検証はPythonでも行う。

既存`commandMessageSchema`はsimulator用v1/v2のままにする。APIは構成報告またはROS観測のあるdeviceをROS対象として識別し、Bridge/Adapter 0.3.0、Capability Profile 1.1.0へだけv3を作る。旧0.2.0/1.0.0構成は読み取れるが操作受付は409 ROS_UPGRADE_REQUIREDとする。報告の鮮度15秒未満、desired一致、ONLINE、新鮮で有効なbattery/LOCAL位置/飛行状態、battery 20%以上、対応能力を確認する。未停止・不確定goalとOTA予約も同じdevice row lockの下で検証し、command・固定構成参照・outboxを同時commitする。複数機体操作も同じ判定を使う。

Bridgeは自機の`commands`へ届いたv3を検証し、本文と受領ACK v2を同じSQLite transactionでcommitした後でMQTT受領を確定する。開始期限以上では`REJECTED_EXPIRED`、期限内では`ACKNOWLEDGED`とする。これは受領の事実だけであり、構成適合・ROS availability・Action受付を意味しない。ROS未接続でも受領を保存できるが、その間はgoalを作らない。古いv1/v2 command、別device、期限相関違反、不正本文にはcommand ACKを生成せず、QUARANTINED_COMMANDとして汎用inboxへ隔離する。実行候補はcommand_receiptsだけから読み、隔離inboxは再起動・version更新後も読み直さない。retainフラグ付き配送はintake前に拒否する。

ACKは永続pending queueからQoS 1・retainなしで送る。PUBACKではpendingだけを解除し、本文と元ACKの正本を残す。同commandId/同canonical本文の再配送では期限後・Bridge再起動後も元のtimestamp/statusで再通知する。別本文では正本を変えずACKを返さない。ACK v2にはDB receiptがないため、PUBACKはDB保存証明ではなく、DB保存までの保証を改善したとは扱わない。

期限拒否の受領記録は、その後の時計逆行で開始可能時刻へ戻っても実行準備を禁止する。受領済み本文と異なるcommandからgoal対応を作ることも拒否する。

## SQLiteの不変対応

SQLite user_version 4でaction_commands、5でcommand_receipts、現在の6でaction_progressを非破壊追加した。query回数・最初の照会UTC、送信意図UTC、終端/停止event正本も永続化する。受領本文/ACK・構成snapshot・結果原文hash・event outboxを重要記録10,000件/32 MiBへ合算する。既存の構成・telemetry・receipt・owner lockは維持する。同じowner threadとWAL/synchronous FULL接続を使い、満杯でも未確認記録を消さない。保存不能では新規操作とheartbeatを止めるが、停止成功は保証しない。

新規commandは端末・構成digest・既知能力・許可Action・開始期限を検証し、本文のcanonical SHA-256、commandId、一度だけ生成するgoal UUID、構成snapshotをREADYとしてcommitする。同commandId・同本文では元の対応を返し、期限後や再起動後も新UUIDへ差し替えない。同ID・別本文は拒否する。

SendGoal前にSEND_INTENTを別commitする。READY以外から送信意図を作れず、開始期限・新鮮な構成/観測・機体側ready・排他を再検証する。Actionのbody goal_idとtransport UUIDへ同じ保存UUIDを使う。再起動時はSEND_INTENT/ACCEPTED/RUNNINGをローカルUNCERTAINへ移し、保存UUIDのGetResult service照会候補にする。再送候補にはしない。READYだけは送信意図前として、元UUID・期限・構成を再検証して進められる。

heartbeatはjournalの不変owner IDを使い1 Hzで送る。新規の空き状態、または同じserver/configと保存済みactive/last terminal goalを照合できる場合だけ許可する。参照serverもgoalのowner_idとheartbeat ownerを照合する。MQTT切断だけでは既存goalのheartbeatを止めない。journal書込失敗・ROS喪失・owner不明では許可せず、permission自体も1.5秒で失効する。

## 実行証拠とDB保存

bridge-events v1をGOAL_ACCEPTED、GOAL_REJECTED、FEEDBACK、EXECUTION、STOP_OBSERVATIONへ拡張した。共通のdevice/command/goal/server/configuration/journal ID、event ID、session、単調sequence、UTCを持つ。CONFIGURATIONにcommandを捏造しない。型とPython用schema/fixtureはpackages/protocolを正とする。

goal acceptは実行開始ではない。startedAtは実feedbackまたはresultから取得し、不変なcommand/goal/受付時構成参照へ結合する。明示goal rejectはREJECTED、startedAtなし、notStarted=trueとし、stopConfirmedを作らない。受領ACK v2の期限拒否も、ROS対象・未送信・時刻を照合して未開始として保存する。ROS対象へsimulatorのACK v3を投影しない。

成功には同じgoal/server/adapter構成、frame、UTC開始/終了、SUCCEEDED、home距離0.2 m以下、速度0.05 m/s以下、1秒以上の安定を要求する。進捗や速度0だけで成功を作らない。ROS resultのCDR原文をSQLiteへ保存し、base64とSHA-256を証拠へ含める。比較用距離/速度は保守的な切上げmm/mm毎秒、安定時間は切捨てms、pose/velocityは丸めた整数とする。異常resultも原文hashをUNCERTAINへ残し、過大な原文はhash/byte数だけを残す。CDR hashは同一本文の識別であり、独立した実行証明ではない。

ingestorはbridge_action_eventsへ正本・hash・採否・受信UTCを保存し、ros_command_targetsの固定参照と照合してcommandsへ投影する。DB commit後だけSTORED receiptを返す。同ID同hashは同じreceipt、別本文は衝突として保持し正本を変えない。BridgeはPUBACKでeventを削除せず、照合できたDB receiptだけで削除する。重複commandには保存済み終端/停止eventを元ID・timestampで再通知する。feedbackは1 Hz以下・未確認最新1件/goalに集約し、終端は捨てない。

終端だけでは予約を解除しない。同じserver/goal/configの新鮮なruntime_stateとpose/速度で、IDLE・0.05 m/s以下を終端後に1秒観測し、元終端から5秒以内にSTOP_OBSERVATIONを保存する。停止証拠が終端より先着した場合はreceiptを返さず再送を待つ。欠測・不明・矛盾では排他を残す。未開始を証明したnotStartedと、実行後のstopConfirmedを区別し、物理安全停止の認証とは扱わない。

GET /commands/:commandId/bridge-executionは配送状態・実行状態、固定構成、goal対応、停止/未開始、矛盾、全証拠の採否を返す。既存のcommand履歴にも実行状態と時刻を追加する。GET /commands/:commandId/bridge-configurationは実startedAtへ結合した当時の構成であり、未開始なら404。REJECTED/CANCELLEDはAPI・画面・固定対象の分母に残し、成功数へ含めない。終端矛盾は正本を保存したまま集約をUNCERTAINとする。

## 照会と不確定

再起動後のGetResultは保存UUID・同server世代だけに送る。1照会2秒、backoff 1〜8秒、最大5回/合計30秒で打ち切る。回数と最初のUTCを永続化するため、再起動しても予算は戻らない。futureの取消は待ちの解放でありgoal cancelではない。参照result cacheは既定900秒、process再起動で失う。再現試験用の短いresult_cache_secはProfileのresultCacheMsと独立profile IDへ報告する。保持窓を過ぎても一度は照会し、UNKNOWN/応答なしをRESULT_CACHE_UNAVAILABLEとして記録する。保持時間だけから成功・失敗を推測しない。

server世代変更、UNKNOWN goal、再照会不能、結果期限超過はUNCERTAIN。API受付から120秒で未報告/RUNNINGもDB側workerがUNCERTAINへ更新し、予約は残す。期限後に届く確かなresultはLATE履歴へ保存するが、元の期限内成功へ書き換えない。確定終端の矛盾は両本文を保存し、先の正本を維持して介入へ渡す。journal喪失の自動初期化や、別UUIDでの穴埋め実行は行わない。

## 更新と検証

受付停止→0023 migration→protocol/ingestor/API/結果期限worker→Bridge/Adapter/interfaces 0.3.0→新鮮なProfile 1.1.0報告の順で更新する。同じcomponent ID/versionの別release digest、同じprofile ID/versionの別定義を上書きしない。旧0.2.0とProfile 1.0.0の履歴は維持し、新たな実行だけを新versionへ限定する。既存simulatorはv2 commandとACK v1/v2/v3のまま共存する。Bridgeをsimulator用OTA bundleへ流用しない。

pnpm test:ros-reference、pnpm test:ros-bridge、pnpm test:ros-observations、pnpm test:ros-commandsを使う。最後の試験は実Action/DDS/Mosquitto/PostgreSQL/APIで成功・拒否・ABORTED、重複、4か所のSIGKILL、GetResult、cache失効、server世代変更、120秒の未報告期限、隔離、停止排他、OTA gate、複数機体集約、simulator共存を検証する。結果は専用一時ディレクトリのaction-evidence.jsonとDB正本へ記録し、container/volume/imageを削除する。合成fixtureのDB試験を実Action検証へ読み替えない。

BRIDGE_TEST_FAULTはBRIDGE_INTEGRATION=trueの試験構成だけで使う送信境界barrierで、通常運用では設定しない。cancel APIと物理停止保証、包括的な通信断注入、LOCAL詳細画面・ROS介入UI、実機・実AWSは対象外。cancelは#195、追加障害E2Eは#196/#198、ROS詳細画面は#197で扱う。
