# ADR 0005: 通信断時の配送保証と復旧境界

- 状態: 採用（Phase 3の実装方針。以下の機能は未実装）
- 決定日: 2026-10-06
- 対象: #108、後続の#109〜#116

## 背景

Phase 2のtelemetryはQoS 0で、simulatorのプロセス停止中は生成されない。commandはQoS 1だが、APIのDB保存とMQTT publishは別処理であり、再起動後の自動再送もない。simulatorの処理済みcommandIdはメモリ上だけに残る。MQTTの送信確認はPostgreSQLへの保存や機体の操作完了を示さない。

Phase 3では、ローカルMosquittoとAWS IoT Coreで同じ復旧規則を使う。ブローカーの永続セッションは有効期限や保存数に依存し、アプリケーションのDB保存も確認できないため、配送保証の根拠にしない。

## 決定

### telemetryの識別とセッション

1件の識別子を`(deviceId, sessionId, sequence)`とする。`sessionId`は機体ごと、simulatorプロセス起動ごとに生成するUUID v4であり、MQTT再接続では変えない。再起動後は新しい`sessionId`で`sequence=0`から始める。SQLiteに残った旧セッションのデータは、元の識別子のまま再送する。load-generatorも実行単位・機体単位で別の`sessionId`を付ける。負荷試験レポート用の`LOAD_SESSION_ID`とは別項目である。

新規telemetryは、セッション情報と連番をSQLiteへ同一transactionで確定してからMQTTへ送る。保存に失敗したデータを「送信済み」と扱わない。生成からSQLiteへのcommitまでにプロセスが停止したサンプルは保持できない。各セッション内で連番は単調増加し、異なるセッションの同じ連番は別データとする。

telemetryメッセージを`schemaVersion=2`へ進め、既存の`fleet/v1/devices/{deviceId}/telemetry` topicは維持する。移行中、ingestorはv1も受け付けるが、v1には永続的な重複排除と保存確認を適用しない。先に受信側をv2対応にしてから送信側を切り替え、v1の残存を計測して廃止する。commandとACKも後述の変更に合わせてそれぞれv2へ進める。接続状態はv1を維持する。

### telemetryの保存、再送、削除

simulatorは機体ごとのSQLite永続バッファにtelemetryの識別子、作成時刻、送信するJSON、送信試行情報を保存する。SQLiteは再起動後も残るvolumeへ置き、transactionの耐久性を優先する設定で使う。telemetryのpublishとingestorのsubscribeはQoS 1、retainなしにする。受信側は`(deviceId, sessionId, sequence)`を一意制約で保存し、同一内容の再受信は成功扱いにする。同じ識別子で内容が異なる場合は衝突として記録し、既存行を上書きせず保存確認も返さない。重複判定には受信時刻を含めず、送信内容の一致を照合する。

Phase 3では自機宛て`fleet/v1/devices/{deviceId}/telemetry-receipts`を追加する。ingestorはPostgreSQLのtransactionがcommitした後、`deviceId`、`sessionId`、`sequence`、保存済みを示す状態を含む受領通知をQoS 1、retainなしで送る。重複だった場合も、保存済みの内容が一致すれば再通知する。端末側の「MQTT送信済み」はQoS 1のPUBACKを受けた時点、「保存確認済み」は対応する受領通知を検証した時点とする。SQLiteの行は保存確認済みになってから削除する。PUBACKはブローカーの受理だけを示すため、削除条件にしない。通知のpublish失敗、通知の欠落、ingestorのcommit直後の停止では、端末が同じ行を再送し、DBの一意制約で重複を吸収する。

再接続後は機体ごとにSQLiteへの追加順で古い行から送る。旧セッションの残件を先に処理し、復旧中に生成した新規データは末尾へ追加する。保存確認を待つ間は当該機体の次の行を送らず、再送には指数バックオフ、jitter、速度上限を設ける。切断やタイムアウト時は未確認行を残す。通常の再接続ではMQTTのclean sessionを使い、ブローカー側のキューには依存しない。

バッファ上限は機体ごとの保存行数と、保存したJSONのUTF-8バイト数の両方で測る。初期値は10,000行・32 MiBとし、どちらかに達したら最古の未確認行から必要な分だけ破棄して新しい行を保存する。新しい1行だけで上限を超える場合はその行を保存せず破棄する。破棄件数、最初と最後の識別子、発生時刻、理由をSQLiteの別の記録へ同じtransactionで残し、ログとメトリクスでも確認できるようにする。受領通知が後から届いた破棄済み行は無視する。バイト上限は論理的なJSON容量であり、SQLiteファイルの物理サイズ上限ではない。ディスク不足、DB破損、書き込み失敗時は生成を停止して異常を通知し、未確認データを黙って捨てない。

PostgreSQLではv2 telemetryの識別子と内容照合に必要な情報を、telemetry行が存続する間保持する。Phase 3でtelemetryの時限削除は行わない。将来の履歴削除には、端末の再送可能期間と重複排除記録の保持期間を一緒に設計する。

### command、ACK、outbox

APIはcommandIdと`expiresAt`を作成し、command行とoutbox行を同じPostgreSQL transactionで保存する。`expiresAt`は端末が新規commandを受領できる締切であり、初期値は作成から30秒とする。ACK待ちのタイムアウト時刻とは別に保持する。`expiresAt`を必須とするcommandは`schemaVersion=2`とし、期限切れを表す`REJECTED_EXPIRED`を追加するACKも`schemaVersion=2`とする。topicは既存の`fleet/v1`を維持する。outboxには送信先、元のpayload、期限、試行回数、次回試行時刻、状態を保存する。workerは複数起動時も同じ行を同時取得せず、期限前に同じcommandIdとpayloadでQoS 1、retainなしのpublishを再試行する。PUBACK後も端末からACKがなければ期限と最大試行回数の範囲で再送する。PUBACKで`SENT`へ進められるが、機体での受領や実行は確定しない。ACKが先に届いた場合は`ACKNOWLEDGED`を`SENT`へ戻さず、以後の再送を止める。

送信試行を始める前に期限へ達したcommandはpublishせず`EXPIRED`とする。試行履歴があるcommandは、PUBACKやACKの欠落により実際の配送結果が不明になり得るため、期限やACK待ち時間に達しても「未実行」と断定しない。この場合は既存の`TIMED_OUT`と試行履歴で不明状態を示す。期限前に受領したACKが後からDBへ届いた場合は、期限超過の記録を残して`ACKNOWLEDGED`へ更新できる。PUBACKを一度も得られず最大試行回数に達した場合は`FAILED`とし、PUBACK後の再送上限に達した場合は送信を止めてACK待ち期限まで`SENT`を維持する。

simulatorはcommandを受けると、`commandId`、deviceId、payload、受信時刻、期限、受領状態、操作試行状態、再送するACKをSQLiteへ記録する。まず処理済みcommandIdを照合し、同じIDでpayloadが異なる場合は衝突として拒否する。未処理で`now >= expiresAt`なら実行せず、`REJECTED_EXPIRED`のACKを返す。期限内に受け付けた場合は、受領を永続化してから`ACKNOWLEDGED`のACKを送る。ACKは受け付けた事実だけを示し、操作の完了通知にはしない。

期限内に永続化して受領したcommandは、操作の直前や再起動後に期限を再判定しない。試行開始前に停止した場合も、復旧後に操作できる。操作の直前には試行開始をSQLiteへ永続化する。試行開始後に停止した場合は、操作が行われたか判定できないため自動で再実行せず、結果を`UNCERTAIN`として端末の履歴とログに記録する。重複受信時は期限を過ぎていても保存済みACKを再送し、操作を繰り返さない。`UNCERTAIN`でも受領済みなら受領ACKを再送し、操作結果の不確定さをACKの意味に混ぜない。ACK自体もSQLiteに残し、QoS 1のPUBACKを得るまで再送する。操作はACKのPUBACKを待たない。ただしPUBACKはingestorのDB更新を保証しないため、APIの表示が`TIMED_OUT`のまま残る場合がある。

移行時はsimulatorとingestorをv1/v2対応にしてからAPIの送信をv2へ切り替える。互換期間中のv1 command/ACKは従来の扱いで処理するが、v1 commandには受領期限がないため本ADRの期限保証の対象外とする。切替前のv1 commandが終端状態になるかACK待ち時間を過ぎるまでv1 ACKを受け付け、v2 commandに対するv1 ACKは状態更新に使わない。切替後はv1 commandの新規受領を拒否し、v1 ACKの残存を計測して受信対応を廃止する。

処理済みcommand履歴は期限から7日間保持し、機体ごとに10,000件を上限とする。上限到達時は期限切れの古い履歴から消す。期限内の履歴を消さなければ収まらない場合は新規commandの実行を拒否して異常を記録する。履歴を削除した後の再受信でも、`expiresAt`を過ぎたcommandは実行しない。期限判定には同期済みの端末UTC時刻が必要であり、時刻が信用できない場合は操作を拒否して異常を記録する。

APIの状態遷移は次のとおりとする。`FAILED`と`TIMED_OUT`も配送・操作が行われなかった証明にはならない。

| 現在の状態                                  | 条件                                                   | 次の状態                                   |
| ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| `PENDING`                                   | PUBACKを受信                                           | `SENT`                                     |
| `PENDING` / `SENT`                          | 有効な受領ACKを受信                                    | `ACKNOWLEDGED`                             |
| `PENDING`                                   | 送信試行前に期限切れ                                   | `EXPIRED`                                  |
| `PENDING` / `SENT` / `TIMED_OUT` / `FAILED` | 端末から期限切れの否定ACKを受信                        | `EXPIRED`（送信試行履歴は保持）            |
| `PENDING` / `SENT`                          | 送信試行後、ACKを確認できず期限またはACK待ち時間に到達 | `TIMED_OUT`                                |
| `PENDING`                                   | PUBACKがないまま再送上限に到達                         | `FAILED`                                   |
| `SENT`                                      | ACKなしで再送上限に到達                                | `SENT`のままACK待ち期限まで待つ            |
| `TIMED_OUT` / `FAILED`                      | 遅れて有効な受領ACKを受信                              | `ACKNOWLEDGED`（期限超過・失敗履歴は保持） |

`EXPIRED`とv2 ACKの`REJECTED_EXPIRED`は#113で`packages/protocol`、PostgreSQL、API表示へ追加する。`UNCERTAIN`は端末側の操作履歴に残し、否定ACKにはしない。既存の`TIMED_OUT`は「ACKを確認できない」状態のままとし、期限切れや実行失敗と同一視しない。

### 保証範囲と失われる条件

| 区間                                               | Phase 3での扱い                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| telemetry生成後のSQLite commit → PostgreSQL commit | 容量内で永続領域が保たれ、通信・DBが最終的に回復する条件で、受領通知まで端末に残してat-least-onceで保存する |
| PostgreSQL commit → 端末の行削除                   | 通知欠落時は再送される。重複保存はしない                                                                    |
| APIのcommand/outbox commit → MQTT publish          | 期限内で再試行する。失敗や期限切れは記録する                                                                |
| MQTT PUBACK → 機体受領 → ACKのDB反映               | PUBACKだけでは到達・実行・ACK保存を保証しない                                                               |

telemetryはSQLiteへのcommit前、上限超過で破棄した行、保存先の故障やデータ消失、端末を長期間動かせない場合に欠損し得る。受領通知経路が復旧しない間は行を保持するが、上限を超えると古い未確認行を破棄する。commandは期限切れ、端末時刻のずれ、操作試行開始後の停止で実行できないか結果が不明になり得る。機体の物理操作とSQLiteのtransactionは原子的にできないため、exactly-once実行や実行完了の保証はしない。接続状態のretained通知は現在の到達確認ではなく、オンライン判定には従来どおり新しい受信とタイムアウトを使う。

## 保存先と後続Issue

| 保存先                          | Phase 3で追加する情報                                                                                        | 主な担当Issue    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| simulatorのSQLite               | 機体・セッション・連番、telemetry JSON、送信試行、未確認破棄記録、処理済みcommand、操作試行状態、再送待ちACK | #109〜#111、#113 |
| PostgreSQLのtelemetry           | v2のsessionId、一意制約、内容照合情報。旧v1行は移行中に区別する                                              | #109、#112       |
| PostgreSQLのcommands / outbox   | expiresAt、送信試行、期限切れ状態、同一transactionで作るoutbox                                               | #113、#114       |
| `packages/protocol`とIoT Policy | v2 telemetry、telemetry-receipts、v2 command/ACK、機体のreceipt購読とingestorのreceipt送信権限               | #109、#111〜#113 |

#111では端末のreceipt購読と削除処理、#112ではDB commit後のreceipt発行を扱う。両Issueで#94のAWS IoT Policyに、このtopicだけの購読・送信権限を追加する。通常経路のtopicと処理はlocal / AWSで共通とし、認証設定とブローカーの接続先だけを切り替える。#115ではDB commit直後、receipt欠落、バッファ上限、API・simulator再起動、command操作試行中の停止を検証する。AWSでの確認は#64の費用上限を守る小規模経路試験に限る。

## 理由とトレードオフ

- ブローカーのPUBACKで端末バッファを消す案は簡単だが、ingestorの停止やDB保存失敗を検出できないため採用しない。
- DB保存後のreceiptを採用するとtopic、Policy、メッセージ数と実装が増える。受信失敗時にも端末に原本を残せる利点を優先する。
- ブローカー永続セッションだけに依存すると、期限切れ・キュー上限・ブローカー変更時に保存境界が変わる。端末SQLiteとAPI outboxを保証の起点にする。
- バッファ上限では古い未確認データを捨てる。欠損を記録して新しい機体状態を優先するためであり、無制限のディスク使用は避ける。
- commandの操作試行前に永続記録すると、停止時に操作が未実行でも再試行できない場合がある。重複した帰還・再起動を避けるため、不確定として人が追跡できる状態を選ぶ。
- `expiresAt`を実行期限ではなく受領期限とする。期限内に永続受領したcommandは復旧が遅れても実行され得るが、受領ACK後に期限切れへ遷移させず、再起動後の動作を一意に保てる。

## 参照

- [通信仕様](../protocol.md)
- [システム構成](../architecture.md)
- [ADR 0002: MQTT](0002-mqtt-protocol.md)
- [ADR 0004: AWS IoT接続](0004-aws-iot-connection-and-credentials.md)
- [AWS IoT Core: MQTTとQoS](https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html)
