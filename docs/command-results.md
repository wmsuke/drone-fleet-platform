# commandの実行結果通知

#152で、受領ACKと別の実行状態をSQLite・PostgreSQLへ保存し、同じcommand-acks topicでACK v3として通知する経路を追加した。commandはv2のまま。#140で[グループ操作の集約API](fleet-operations-api.md)を追加した。単一機体のHTTP履歴・ダッシュボードの配送/受領表示は維持し、操作画面は#141で扱う。

## 通知と完了条件

simulatorの受領・期限拒否ACKは引き続きv2で送る。ingestorはv1/v2とv3の受領・期限拒否を受け付ける。実行通知はv3の`RUNNING` / `SUCCEEDED` / `FAILED` / `UNCERTAIN`で、`startedAt`が必須である。`timestamp`はその実行状態を記録した端末UTC時刻で、startedAt以前の値は不正とする。受領・期限拒否にはstartedAtを付けない。型と検証は`packages/protocol`に置く。

| 操作 | 成功の条件 | 成功と扱わないもの |
| --- | --- | --- |
| RETURN_HOME | 10秒の仮想帰還処理を終え、起動時の位置・高度0・IDLEへ移った後にSQLiteへ結果をcommit | 受領ACK、RETURNING_HOMEへの変更、開始記録のみ |
| REBOOT | 切断後の新しい接続世代で再購読し、その世代のONLINE通知のQoS 1 PUBACKを取得した後にSQLiteへ結果をcommit | 切断完了、reconnect呼び出し、受領ACK、以前の接続の遅れたONLINE確認 |

帰還中は開始位置から起動時の位置へ経過時間に応じて移動し、高度を0へ下げる。帰還完了後は位置とIDLEを維持する。実機の着陸・安全を証明するモデルではない。simulatorは同時に1つの操作を扱い、実行中の別commandは受領記録後にFAILEDとして結果を残す。複数operationの受付は並行できるが、機体の排他スケジューラ・予約・順序保証を追加したものではない。

## SQLiteと送信

新規受信commandは初期接続・購読・ONLINE送信の開始処理が完了してから処理する。初期化失敗時は待機中の操作を開始しない。保存済みRECEIVEDの復旧では、再接続イベントの受付を有効にしてから操作を開始し、REBOOTの新しい接続でONLINE確認を行う。

command_historyへ実行通知JSON、送信待ちフラグと世代を追加する。STARTEDとRUNNING通知、終端状態と最新通知はそれぞれ同じSQLite transactionでcommitする。操作は受領ACKのPUBACKを待たない。receiptと実行通知は別の送信待ちで、同じtopicへQoS 1・retainなしで送る。最新状態だけを送るため、すぐに終端へ進んだ場合はRUNNINGが届かないこともある。

再起動時にSTARTEDが残っていればUNCERTAIN通知を永続化し、自動再実行しない。端末の再起動後も既存の受領・実行通知を再送できる。同じcommandの再配送では保存済みの受領と最新実行結果を再通知し、操作を繰り返さない。PUBACKでは本文と送信世代の両方が一致した待ちだけを解除する。新しい結果だけでなく、同じ本文の再配送要求も古いPUBACKで解除しない。

旧SQLiteは起動時に列を追加する。旧COMPLETEDには現在の完了条件を適用した証拠がないので、SUCCEEDEDを捏造しない。旧STARTEDはUNCERTAINにする。履歴の7日・10,000件の上限は維持し、容量で期限切れ履歴を早く削除する場合もある。未確認の実行通知も履歴の消失・期限後の削除・ディスク障害で失われ得る。

結果保存の失敗後は成功通知を作らない。開始記録が残れば復旧時にUNCERTAINとする。再起動操作中の通信エラーは、実際の切断の有無を断定せずUNCERTAINとする。通知のpublish失敗・タイムアウト・切断では永続待ちを残し、既存の指数バックオフ・jitter・速度制限を使って再試行する。

## PostgreSQLの正本と履歴

配送/受領は既存commands.status、実行はcommands.execution_statusで別に管理する。実行状態の初期値はNOT_REPORTED。完了結果だけが届いても受領ACKを捏造せず、配送状態を上書きしない。

| 列 | 意味 |
| --- | --- |
| execution_started_at | 端末のstartedAt |
| execution_started_received_at | 開始情報を含む最初の有効通知をDBへ反映した受信時刻 |
| execution_result_at | 現在の終端・不確定結果の端末timestamp |
| execution_result_received_at | その結果のサーバー受信時刻 |

command行をロックし、状態更新とcommand_execution_eventsへの記録を同じtransactionで保存する。通知はdeviceId・commandIdとversionを照合する。v1 ACKは期限なし旧command、v2/v3は期限付きv2 commandに限る。実行開始時刻は作成時刻以上・開始期限未満で、既保存のstartedAtと同じでなければ衝突とする。APIと端末のUTC時刻の同期を前提とする。開始後の終端通知は開始期限や結果確認期限の後でも受け付ける。

| 現在の状態 / 通知 | 扱い |
| --- | --- |
| NOT_REPORTED → RUNNINGまたは終端結果 | 実行状態と時刻を保存する |
| RUNNING → SUCCEEDED / FAILED / UNCERTAIN | 結果を保存する |
| SUCCEEDED / FAILED → 後着RUNNING / UNCERTAIN / 同じ結果 | 確定結果を戻さずignoredとして履歴に残す |
| SUCCEEDEDとFAILEDの不一致 | conflictとして記録し、先に確定した結果を上書きしない |
| UNCERTAIN → SUCCEEDED / FAILED | 確かな終端結果へ更新する。過去のUNCERTAINも履歴に残る |
| UNCERTAIN → RUNNING / UNCERTAIN | 不確定状態を戻さない |
| EXPIREDに対する実行通知、実行通知保存後の期限拒否 | 到着順にかかわらずconflict。保存済みの正本を変えない |

同じcommandId・status・端末timestamp・startedAtの再受信では行を増やさず、最初の受信時刻を保持する。イベント履歴のdispositionはapplied / ignored / conflict。衝突は警告して成功扱いにしない。知らないcommandや別機体への通知は状態を更新しない。この業務履歴は認証済みactor付きaudit logではなく、管理者改ざんへの保証も提供しない。

## 保証境界と更新

PUBACKはbrokerの受理のみで、ingestorのDB commitを保証しない。API outboxは受領ACK後に再送を停止するため、結果がbrokerまで届いてDBへ反映されないと、以後も未報告・進行中のまま残り得る。結果保存receiptや無期限の自動再通知は追加していない。#140では受付済みのresultDeadline（120秒）で結果未応答を評価し、既存ACKやtelemetryだけで成功を補完しない。

SQLiteのcommitと物理的な操作は原子的でない。重複を避けるため、結果不明のcommandは自動再実行せず、exactly-once実行を保証しない。通知履歴が削除された後の再配送は、過去の結果を再構成できない。

更新時はcommand受付を停止し、PostgreSQL migration → ingestorのv3対応 → simulatorのSQLite更新と結果通知対応の順に揃えて再開する。旧command/ACK v1/v2の読み取りを維持する。旧simulatorの結果を成功へ補完しない。topic・QoS・retain・IoT Policyの追加変更はなく、localとAWSのtransportに同じ処理を使う。実AWSでの通信確認は今回行っていない。

## 検証

protocolの時刻・必須項目、SQLiteの移行・再起動・再通知・古いPUBACK、simulatorの帰還完了・ONLINE PUBACK前の成功抑止・競合操作を単体テストで確認する。専用PostgreSQLで同時通知、重複、後着、UNCERTAIN解消、終端不一致、期限拒否との矛盾、DB制約を検証する。

`DATABASE_INTEGRATION=true pnpm telemetry:test:integration`は実Mosquittoを一時起動し、RETURN_HOME / REBOOTの保存と、結果がDBへ反映されない場合の同じcommandによる再通知を検証する。使い捨てDBのPOSTGRES_*を設定する。既存のreceipt・ACK v1/v2とAPI・outboxも結合試験で確認する。AWSの実通信や100台の結果通知性能を検証したものではない。
