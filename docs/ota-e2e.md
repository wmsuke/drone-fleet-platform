# OTAの段階配信・障害停止・復旧E2E

## 実行前に固定する条件

`pnpm test:ota-fleet`は専用ComposeのPostgreSQL 17、Mosquitto 2、Linux Node 22で実行する。各シナリオ10台の独立したsupervisor・SQLite・子アプリを使い、異なる署名済み実bundleをHTTP配信する。AWS資源は作らない。

- 正常系は1/3/6台、各段階は明示承認。全対象の新boot・version/digestと13標本/60秒healthを要求する。
- 本番の同時適用2台・claim 1件/秒・開始300秒/結果600秒を維持する。独立workerを2個起動し、先行配信中にbackendを停止・再起動する。
- 正常系の上限660秒。障害系も10台を登録し、先行1台の新アプリ起動後にtelemetry receiptを遮断する。後続9台のAPPLY送信0件、旧bundle維持を要求する。
- receipt復旧後にROLLBACKを理由付き承認し、保持旧bundleの実起動とbackendの60秒health評価を確認する。元更新失敗とRECOVEREDを分け、deploymentはWAITING_FOR_HUMAN、予約10件を保持する。
- simulatorの新版起動後は仮想飛行が再開するため、rollback前に端末側のRETURN_HOMEを直接MQTTで実行し、実行結果を確認する。この準備をHUMAN_REVIEWに記録する。管理APIの予約gateを緩めず、画面から帰還できることや自律復旧を証明したとは扱わない。
- rollback中にもreceiptを遮断して回復失敗、旧鍵を無効化して回復不能を別シナリオで確認する。元更新失敗と回復失敗を上書きせず、再帰rollbackしない。
- 新版起動後にOTA報告を遮断し、同keyの停止要求を並行送信する。60秒の停止確認期限で人間判断待ちとし、報告復旧後も自動昇格しない。
- 必須承認は正常系3件、障害系1件。障害対応はrollback承認（または報告欠落時の明示停止）1件と判断対応1件。同key再送で介入・復旧を増やさず、判断終了でも予約を解放しない。自動停止は人間介入へ数えない。
- 成功・失敗にかかわらず、専用container/network/volume・runner image・子アプリ・一時SQLiteと配信物を削除する。共有のbase imageとbuild cacheは残す。強制killやホスト停止時はtrapが走らないため、ログにあるproject名を使い手動で片付ける。

## 記録

出力先は実行時に表示する一意の一時ディレクトリである。`test.log`の`OTA_FLEET_REPORT`行はJSONで、実時刻、段階承認/通過時刻、対象・attempt・評価、送信command、outbox再送数、受信イベント数、復旧・介入を保存する。`services.log`はサービスログ、`cleanup.log`は削除結果とテスト終了値である。費用は未計測のためnullとし、0円や自律復旧成功へ読み替えない。CIでは失敗時も14日間artifactを保存する。

## 障害マトリクスと保証境界

| 条件 | 検証層 |
| --- | --- |
| 10台1/3/6、実更新、承認gate、backend再起動、複数worker | `test:ota-fleet` 実MQTT/DB/Linux |
| 先行health失敗、後続抑止、明示rollbackと回復評価、介入件数 | `test:ota-fleet` 実MQTT/DB/Linux |
| rollback失敗/不能、報告欠落・停止競合・人間引継ぎ、旧attemptの重複遅着 | `test:ota-fleet` 実MQTT/DB/Linux |
| 保存receipt欠落と重複受信 | `test:ota-backend` 実MQTT/DB/Linux |
| 不正署名・破損artifact・非互換・容量不足、receipt断、download停止、切替前後と起動時の不明状態 | `test:ota-device` 実Linux・Broker代替、journal境界fixtureを含む |
| 遅延/古いattempt、停止競合、retry予算、rollback失敗/不能・人間引継ぎ | `api:test:integration` 実DB・制御clock/証拠fixture |

コンポーネント検証を10台すべてへの物理的障害注入と同一視しない。OSの強制電源断、実機firmware、実AWSのOTA、ブラウザからの実更新、長時間負荷、ネットワーク課金量は未確認である。

## 初回ローカル実測（2026-11-04）

OrbStack上のLinuxコンテナで正常系10台を2回完走した。1回目は05:50:14.576〜05:59:43.352 UTC、全体568.776秒、段階1/3/6は71.275 / 143.626 / 242.279秒だった。全10targetがSUCCEEDED、更新attempt 10件、必須承認3件、復旧0件である。OTA保存イベント541件、MQTTイベント配送1,564件、receipt配送1,564件を観測した。MQTT配送数にはINVENTORYと重複を含むため保存イベント数と同一視しない。2回目は05:58:29.892〜06:08:25.541 UTC、595.649秒で全10台の成功を確認した。

この実測は本変更の正常系テストを使ったもので、他のローカルテスト・ビルドとの同時実行を含む。性能保証や専有環境での比較値ではない。正常系取得後に旧runnerを停止して修正版へ切り替え、専用環境のcleanupを確認した。

端末障害テストは容量不足・download停止追加後に14件成功した。その後追加した「health失敗後のSTOP」の回帰テストで、FAILEDがSTOPPEDへ変わり復旧観測が止まる不具合を再現した。停止確認通知と既知の失敗終端を分け、FAILEDを保持する修正を含めた。通常更新・失敗・復旧の履歴やhealth成功条件は緩めない。

全体の単体テストは893件成功、217件は専用環境が必要なためskipした。ローカルでは同時worker 2、test timeout 15秒で実行した。既存archive検証が標準5秒を超えた試行も記録し、同入力の単独再実行34件は成功した。専用E2Eの結果はこの単体テスト件数に含めない。
