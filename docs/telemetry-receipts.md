# telemetryのDB保存確認receipt

## 通信と削除条件

`fleet/v1/devices/{deviceId}/telemetry-receipts`はingestorから機体へQoS 1・retainなしで送る。型と検証は`packages/protocol`の`telemetryReceiptMessageSchema`に集約する。

```json
{
  "schemaVersion": 1,
  "deviceId": "drone-001",
  "sessionId": "a065e32b-c00b-452e-9cb1-3b52c43962fb",
  "sequence": 12,
  "timestamp": "2026-10-09T00:00:00.000Z",
  "status": "STORED"
}
```

timestampは通知の作成時刻であり、照合には`deviceId / sessionId / sequence`を使う。ingestorはtransactionのcommit後だけ送信する。同じ内容の重複にも再通知し、内容衝突・検証失敗・DB保存失敗には送信しない。旧v1 telemetryはreceipt対象外である。通知のpublish失敗はDB保存を取り消さず、ログに記録する。通知publishのPUBACK待ちは10秒で打ち切る。

simulatorは送信前に自機topicを購読し、再接続時も購読する。通知のJSON・schema・deviceIdを検証し、SQLiteの識別子と一致した行だけを削除する。retainされた通知、他機体、不正な通知、削除済み・破棄済みの識別子は無視する。receiptはPUBACKより先に届いても受け付ける。

## 再送と保証境界

PUBACK済みの行も未確認のまま保持する。機体ごとに最古行を送り、receiptなしでは次行を送らない。新規生成は末尾に追加する。`TELEMETRY_PUBLISH_TIMEOUT_MS`（既定10秒）はPUBACK待ちと、PUBACK後のreceipt待ちの最小再試行待機時間に共用する。再送の待機はこの値・`TELEMETRY_REPLAY_INTERVAL_MS`・指数バックオフとjitterの最大値を使い、receipt確認後もreplay間隔を守る。`TELEMETRY_RETRY_BASE_MS`と`TELEMETRY_RETRY_MAX_MS`は既存の設定を使う。

保存待ちの間のshutdownはSQLite行を残す。再起動後は旧sessionIdの行から再開する。DB commit直後の停止や通知欠落では同じ識別子が再送され、一意制約により重複保存せずreceiptを再発行する。

容量内で永続領域が保たれ、通信・DB・通知経路が最終的に復旧する条件でSQLite commitからPostgreSQLまでat-least-once保存する。SQLite commit前の停止、ディスク故障、手動削除、容量超過で破棄した行は対象外である。容量超過時は従来どおり最古未確認行を破棄し、receipt待ち中の行も例外ではない。破棄後に届いた通知は他の行を削除しない。

## 検証

テスト専用PostgreSQLの`POSTGRES_*`を設定し、`DATABASE_INTEGRATION=true pnpm test:telemetry-receipts`を実行する。Dockerが必要で、テストが専用Mosquittoを一時起動し、終了時に削除する。実SQLite・MQTT・PostgreSQLで、ingestor不在、DB接続断、commit済み通知欠落、ingestor再起動後の重複排除と行削除を確認する。simulatorのunit testでは順序・速度、遅延・重複・他機体通知、PUBACK済み行のプロセス再起動、容量上限を検証する。CIのPostgreSQL integrationにも含める。

## AWSの確認と費用境界

localとAWSで通常のreceipt処理は共通である。Terraformはdeviceに自機receiptのSubscribe / Receive、ingestorにreceipt suffixだけのPublishを許可する。receiptのRetainPublishとdeviceからのreceipt送信は許可しない。AWSの実環境ではPolicy更新を適用してから新しい接続で確認する。今回の実装では実AWSへの適用・通信試験は実行していない。

AWSでの確認は2台・60秒間隔・最大10分を目安にする。既存SQLiteのbacklogを先に確認し、大きい場合はローカルで検証する。上限時間を外部タイマーで守り、通信が復旧しない場合も継続送信しない。データを捨てて試験を成立させない。

5 KB以内のtelemetryとreceipt、各購読者1つ、再送なしなら1サンプルにつきtelemetryのpublish / 配送とreceiptのpublish / 配送で4メッセージ分となる。2台各10サンプルなら80メッセージ分であり、status・command・接続時間・再送は別に加算する。再送はDB行数を増やさなくても通信量を増やす。料金は実際のpayloadサイズと配送先数を使い、[AWS IoT Core料金](https://aws.amazon.com/iot-core/pricing/)の5 KB単位で確認する。この数値は通信量の試算であり請求実績ではない。

実AWS試験前にはselected Region、Free/Paid plan、クレジット残高・期限、spend limitを確認する。AWS Settings > Billingで残高とspend状況を確認し、無料であると断定しない。短時間試験は#64の費用上限に従い、継続負荷試験はローカルだけで行う。
