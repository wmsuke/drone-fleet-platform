# telemetry-ingestorバッチ保存の比較

Issue #86で、telemetry-ingestorのDB保存を1メッセージ1 transactionから最大100件のバッチへ変更した。最大待機時間は50ms、保存待ち・保存中の上限は10,000件とし、Issue #63と同じApple M2 / 16 GiB環境、5秒warmup、30秒計測で比較した。

DB保存時間は各MQTT受信から、そのメッセージを含むbatch transactionのcommit完了までを表す。batch全体が失敗した場合は含まれる全メッセージをDB保存失敗として数える。

## 結果

各値は3試行を試行順に記載する。両条件とも欠損、API error / timeout、誤OFFLINEは全試行0だった。

| 条件          | 実装   |           DB保存p95 (ms) |          API p95 (ms) |          ingestor最大CPU |  ingestor最大メモリ |
| ------------- | ------ | -----------------------: | --------------------: | -----------------------: | ------------------: |
| 3,000台・1秒  | 変更前 | 30,000 / 30,000 / 60,000 | 208.4 / 219.2 / 231.1 | 100.1% / 101.7% / 134.7% | 737 / 704 / 726 MiB |
| 3,000台・1秒  | batch  |             50 / 50 / 50 | 162.3 / 154.7 / 230.3 |    40.9% / 31.2% / 32.2% |   129 / 88 / 97 MiB |
| 10,000台・5秒 | 変更前 |   30,000 / 1,000 / 5,000 | 414.9 / 198.1 / 183.2 | 148.7% / 106.1% / 102.4% | 667 / 250 / 275 MiB |
| 10,000台・5秒 | batch  |            500 / 50 / 50 | 267.0 / 186.2 / 204.1 |    58.3% / 34.5% / 33.0% |  87 / 126 / 132 MiB |

3,000台・1秒ではDB保存p95が30〜60秒から全試行50msへ改善した。ingestorの最大CPUは31〜41%、最大メモリは88〜129 MiBまで下がった。10,000台・5秒でもDB保存p95は50〜500msとなり、最大CPUとメモリも低下した。

API p95はホスト上の他コンテナとPostgreSQLの負荷にも影響されるため試行間の変動が残るが、両条件とも500ms未満を維持した。protocol validation、deviceId、sequence、device timestamp、server receipt timeの意味は変更していない。

## 実装上の扱い

- `TELEMETRY_BATCH_SIZE`件へ達するか、`TELEMETRY_FLUSH_INTERVAL_MS`を経過した時点でflushする。
- 同一deviceの複数メッセージはbatch内で最新の`receivedAt`へ集約し、既存の`last_received_at`より古い値では更新しない。
- batch transactionが失敗した場合、全メッセージのPromiseを失敗させ、既存のmetricsとerror logへ記録する。
- 保存待ちと保存中の合計が`TELEMETRY_MAX_BUFFER_SIZE`へ達した場合は新規メッセージを失敗扱いとし、メモリを無制限に増やさない。
- shutdownではMQTT接続を閉じて新規受信を止め、残ったbufferをflushしてからDB connectionを閉じる。

生の試行結果は機体別明細を含むためGit管理外とし、本書へ比較値を残す。
