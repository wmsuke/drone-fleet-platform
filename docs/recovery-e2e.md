# 通信断・再起動・再接続の復旧E2E

## 実行

Docker Engine / Compose v2、Node.js 22.13以降、pnpmと依存パッケージが必要である。

```bash
pnpm test:recovery
```

`compose.recovery.yaml`で試験専用のPostgreSQL 17、Mosquitto、ingestor、API、simulatorと観測用probeを起動する。通常のCompose project、`.env`、既存DB・SQLite volume、AWS認証情報は使わない。HTTP / MQTTのポートはlocalhostへ動的に割り当て、broker再起動後は割り当てを再確認する。

APIとsimulatorは実際の起動ファイルをコンテナ内で実行する。停止試験にはSIGKILLを使い、DB・SQLiteへの保存をプロセス再起動後に確認する。操作開始直後の短い区間だけは、公開`CommandStore`で`STARTED`をcommitして試験用execプロセスをSIGKILLする停止境界fixtureを使う。物理操作中を狙って停止したという意味ではない。

## 検証する境界

| シナリオ | 確認内容 |
| --- | --- |
| Mosquitto停止 | simulatorが生成を続け、未確認telemetryをSQLiteへ蓄積する |
| simulator強制停止・再起動 | 永続バッファを残し、broker復旧後に旧sessionと新sessionのデータを保存する |
| telemetryの重複2回配送 | 各配送のDB保存確認receiptを受け取り、同じsessionId / sequenceのDB行は1件に保つ |
| command受付後・送信前のAPI強制停止 | broker停止中に202 / PENDINGで保存し、API再起動後にoutboxを再開する |
| PUBACK後・機体受領前のAPI強制停止 | simulator不在でSENTになったcommandを、再起動後に同じcommandId・payloadで再送してACKを保存する |
| command処理後のsimulator強制停止 | 同じcommandのACKを再送し、操作時刻を変えず、帰還操作を再実行しない |
| 期限切れcommand配送 | REJECTED_EXPIREDを返し、開始・処理時刻はnull、機体状態も帰還へ変わらない |
| STARTEDのcommit後の停止境界 | 復旧時にUNCERTAINを記録し、受領ACKは返すが操作を自動再実行しない |
| バッファ3行の上限超過 | 最古の未確認行の破棄を記録し、保存行・残件・破棄した識別子を突き合わせる |

起動済みsimulatorの通信断を検証する。broker停止中のsimulator初回起動を成功させる試験ではなく、停止したsimulatorはbroker復旧後に再起動する。容量上限は再起動後も3行のままなので、復旧直後の新規生成で旧行がさらに破棄される場合も結果に含める。容量試験の再開前には試験用`recovery-probe` telemetryのreceiptでingestorの再購読を確認する。この準備用データは機体の件数集計に含めない。

## 結果とログ

`recovery-results/<project>/`へ次を保存する。`RECOVERY_RESULTS_DIR`で保存先の親ディレクトリを変更できる。

- `result.json`: 各シナリオの実測件数・識別子・outbox試行情報・端末の操作履歴、失敗したphase、cleanup結果。
- `services.log`: 時刻付きの全サービスログ。成功時も保存する。
- `commands.log`: 起動・停止・観測コマンドの結果。

通常の復旧では、停止時のSQLite識別子が全てPostgreSQLに存在すること、各sessionの0から最終commit済みsequenceまでに説明できない欠損がないこと、DBに同じ識別子の行が重複しないことを確認する。停止前にDB保存済みだがreceipt未受信だった行は、再送件数と新規DB保存件数を分けて記録する。

容量試験の`lost`は「破棄記録があり、DBにも残らなかった識別子」である。破棄件数そのものを欠損件数にしない。対象の旧sessionで`commit済み件数 = DB保存件数 + lost件数`が成立し、`missing`（破棄記録でも説明できない欠損）と`duplicates`が空であることを検証する。SQLite commit前の生成サンプルや、ディスク破損・volume削除による欠損は保証対象ではない。

テスト処理は5分の上限を設け、各待機にも上限を設ける。`finally`で観測MQTT接続、専用コンテナ、volume、ネットワークと試験専用imageのtagを片付け、残存リソースも確認する。共通のPostgreSQL・Mosquitto imageやbuild cacheは消さない。Vitestが失敗・タイムアウトしても、起動スクリプトのEXIT trapで同じ専用projectを再度片付ける。診断用の結果とログは削除しない。OS停止やSIGKILLで起動スクリプト自体が失われた場合は、結果に残った`recovery-*` projectだけを確認して手動で片付ける。

GitHub Actionsの`Communication recovery E2E`で同じコマンドを実行し、成功・失敗を問わず結果とログを14日間artifactへ保存する。通常の`pnpm test`ではこのE2Eをskipし、Dockerを使わない突き合わせロジックのテストだけを実行する。

## ローカルの検証記録

2026年10月13日、macOS / OrbStack、PostgreSQL 17、Mosquitto 2.0.22、runtime Node.js 22で連続2回成功した。いずれもcommand再送・重複防止・期限切れ・UNCERTAIN復旧、説明できないtelemetry欠損とDB重複なし、cleanup成功を確認した。

| 実行 | 通信断中の蓄積 / 観測した旧行の再送 | 通常復旧時のDB行 / 一意識別子 | 容量試験の旧session commit / DB保存 / 記録で説明できる欠損 |
| --- | --- | --- | --- |
| 1 | 6 / 6 | 15 / 15 | 10 / 5 / 5 |
| 2 | 5 / 5 | 15 / 15 | 9 / 6 / 3 |

実行2の蓄積5件のうち1件は停止前にDB保存済み・receipt未確認で、新規DB保存は4件だった。通常復旧を停止した時点のSQLite残件も結果に残す。これは未確認件数であり、DB未保存件数と同じとは限らない。件数は固定の合格値にせず、各実行の識別子を突き合わせる。

## AWSの確認範囲

このテストはlocal Mosquitto専用であり、AWSへの接続、リソース作成、課金を伴う試験は行わない。`result.json`にも`transport: local`、`aws.executed: false`と未確認範囲を残す。AWS IoT Core mTLS・IoT Policy・実AWSでの再接続挙動を、この結果だけで検証済みとは扱わない。

実AWSでの確認を行う場合は[#64の費用境界](load-testing/aws-iot-free-tier.md)に従い、現在のplan・残りクレジット・月間送信量を確認し、小規模・短時間に制限する。既存の[AWS E2E](aws/e2e.md)は通常経路の試験であり、この障害注入試験の代わりにはならない。
