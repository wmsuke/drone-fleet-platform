# 複数機体commandの負荷検証

Issue #146のローカル検証。telemetryの定常負荷とは分け、group受付から個別command/outbox、MQTT、ACK v3保存、operation集約までを測る。AWSには接続しない。

## 再現手順

Docker、Node.js、リポジトリ指定のpnpmを用意し、依存をインストール・buildする。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm load:test:fleet
```

既定は10台・100台、success/failure/unresponsive、各3試行。各試行で専用Compose projectと空のPostgreSQLを作り、終了・失敗時は専用containerとvolumeを削除する。既存のComposeは変更しない。結果は`load-results/fleet-<日時>/`へ残る。既存の出力directoryを再利用すると拒否し、古いreadyや結果の混入を防ぐ。中断時はSIGINT/SIGTERMで終了する。ホスト強制停止時は残った`fleet-load-<日時>-...`だけを確認して手動で片付ける。

```sh
FLEET_LOAD_COUNTS=100 FLEET_LOAD_CONDITIONS=unresponsive FLEET_LOAD_TRIALS=3 \
  FLEET_LOAD_OUTPUT=load-results/fleet-command-repeat pnpm load:test:fleet
```

`FLEET_LOAD_API_PORT`で専用API公開port（既定18146）を変更できる。DB・MQTTは公開せず、通常の`.env`も読まない。1,000台は`FLEET_LOAD_COUNTS=1000`で明示した場合だけ実行する。通常運用の対象数上限100は変更せず、専用Composeだけ対象台数に合わせる。基準未達やgenerator障害では次段階へ進まず非0で終了し、途中までの結果を残す。

出力は`environment.json`、試行ごとの`trial.json`（DB時系列・command時刻・本番詳細SQLのEXPLAIN）、`acceptance.json`、`responder.json`、`container-stats.json`、`summary.json`、全試行の`report.json`。後から集約し直す場合は`node scripts/summarize-fleet-load.mjs <出力directory>`を使う。

## 条件と計測境界

- MQTT応答器は機体ごとに別clientId・接続とproduction topicを持ち、全台のSUBACK完了後に開始する。成功条件は全台成功、失敗条件は番号が10の倍数の10%がFAILED、未応答条件は同じ10%が受領・実行ACKを返さない。残り90%は成功する。
- 応答器はcommand v2を検証し、ACKNOWLEDGED→RUNNING→100ms待機→SUCCEEDED/FAILEDのACK v3をQoS 1で送る。commandId単位で再送を重複処理しない。simulatorの飛行・SQLite・telemetryは動かさないため、その性能を示す試験ではない。
- deviceとgroup/membershipは専用DBへfixtureとして直接作る。通常のPOST `/fleet-operations`、outbox worker、Mosquitto、ingestor、alert/operation audit workerは本番実装を使う。device登録やgroup編集の時間は受付計測に含めない。
- 接続完了待ち・migrationは計測外。専用APIの最初のoperationを測り、追加warmupは行わない。各試行は単一operationで、同時多group受付や長期履歴の性能保証ではない。
- 10/100台の成功・失敗条件は10秒、未応答条件と追加の1,000台は35秒間、詳細APIを並列1・目標100ms間隔で呼ぶ。別に500ms間隔で終端を監視し、DBのcommit済み件数・backlog・接続・待機lockも観測する。probeは遅い要求の後に追い付き送信しないため、一定到着率の限界負荷ではない。1,000台でも詳細の返却pageは先頭100件で、全体の1,000件を集約した件数を検証する。
- 受領ACKのDB受信時刻とDB commitは同じではない。`ackReceivedAfterPublishMs`は応答器publish呼出し→サーバー受信記録、`ackAllVisibleFromPostMs`はPOST開始→応答予定全台のcommit済みACK件数を初めて読めた時間。後者は500ms＋query時間の観測誤差を含む。端末・DB・probeは同じホスト時計を使う。
- operation完了時間はPOST開始→集約APIで終端を最初に観測した時間であり、DB commit時刻や飛行完了時刻ではない。未応答は通常の開始期限30秒とTIMED_OUTを経て判定し、結果確認期限120秒や本番仕様を短縮しない。
- publishのunique throughputは初回publish済み件数÷（command作成→最後の初回PUBACK記録の時間）。リトライはattemptsで別に数え、PUBACKを実行成功とは扱わない。backlogは未受領PENDING/SENTの件数であり、実行中件数ではない。500ms samplingの最大値なので瞬間的な最大値を保証しない。
- 受付HTTP全体と、repositoryのlock/検証、operation、command、outbox、target、audit/commitの区間を分ける。区間はDB往復・serializationを含み、CPU時間だけではない。計測出力に失敗してもcommit済み受付は失敗にしない。
- CPU/memoryはPhase 2.5と同じDocker stats。CPUは1 core=100%で、コンテナ全体が100%を超える場合がある。memoryはDocker表示の使用量でありRSSと同じではない。応答器は別にevent loop遅延・CPU時間・RSSも保存する。DB接続・lockはsnapshotなので短い待機を取り逃がし得る。

応答器内部のCPU時間・event loop分布は接続開始から停止までの値で、購読の立ち上げも含む。Docker statsは試行直前から計測終了までの標本である。生成側の最大能力を切り分けるには、別ホストや分割した応答器での再測定が別途必要になる。

## 判定

Issueの100台の初期基準は受付5秒以内、詳細API p95 500ms未満、error率1%未満、target/commandの欠損0、DB接続枯渇・処理不能なし。これらは変更していない。試験の追加チェックとしてoutbox欠損0・timeout 0・シナリオ別の終端と件数の一致も要求し、DB計測エラー・generatorエラーは成功扱いしない。詳細APIのpercentileは成功応答のbody受信完了までをnearest-rankで計算する。errorとtimeoutは別に数える。1,000台へ同じチェックを適用するのは追加確認であり、Issueの100台基準とは区別する。

## 実測結果

2026-10-20、Apple M2（8 core、RAM 16GiB）、macOS 14.5、OrbStack / Docker 29.8.2（8 CPU、7.82GiB）、ホストNode.js 24.21.0 / pnpm 10.28.1で実施した。containerはNode.js 22.23.3、PostgreSQL 17.11。Mosquitto 2.0.22を使う。ホストは専有機ではなく、負荷試験と重なるbuild・単体テストは避けたが、他のホスト処理までは隔離していない。

必須条件はcommit `3d1267a`の実装で18試行を完了した。後続の`1848fd6`で同じ保存データから資源・DB可視化時間を集約し、追加の1,000台だけ観測時間を35秒にした。productionの配送・保存・集約アルゴリズムは変更していない。ボトルネック改善を行った前後比較ではない。

以下は各条件3試行の最小〜最大。percentileを平均した値ではなく、試行ごとのpercentileの範囲である。全18試行・3,225回の詳細probe要求でHTTP error・timeoutは0。100台だけでは1,609要求。各試行のtarget/command/outboxは10または100件で一致し、欠損0。generatorエラーとDB samplingエラーも0だった。

| 台数 / 条件     |    受付HTTP ms |   詳細p50 ms |    詳細p95 ms |    詳細p99 ms |
| --------------- | -------------: | -----------: | ------------: | ------------: |
| 10 / 全件応答   |   55.06〜62.16 | 10.13〜11.43 |  21.82〜31.49 |  55.31〜63.48 |
| 10 / 10%失敗    |  60.02〜340.55 | 12.76〜12.81 |  25.87〜33.54 |  54.56〜77.16 |
| 10 / 10%未応答  |   51.15〜70.09 | 11.94〜12.32 |  26.68〜29.98 |  44.55〜57.88 |
| 100 / 全件応答  |   79.36〜96.22 | 13.02〜18.47 | 32.17〜169.42 | 75.09〜276.62 |
| 100 / 10%失敗   | 105.84〜136.76 | 12.97〜18.09 |  34.71〜51.64 | 66.35〜309.95 |
| 100 / 10%未応答 |  92.53〜126.47 | 15.92〜17.04 |  30.28〜34.38 |  44.25〜56.80 |

| 台数 / 条件     | unique publish 件/s | ACK受信p95 ms | ACK全台DB可視化 ms |      終端初回観測 ms |
| --------------- | ------------------: | ------------: | -----------------: | -------------------: |
| 10 / 全件応答   |        30.58〜50.25 |         5〜25 |           564〜575 |       573.53〜590.31 |
| 10 / 10%失敗    |        18.48〜21.60 |         8〜14 |         661〜1,085 |     870.39〜1,182.92 |
| 10 / 10%未応答  |        25.25〜47.85 |         3〜22 |           567〜583 | 30,317.61〜30,543.21 |
| 100 / 全件応答  |       17.93〜115.61 |          2〜8 |       1,093〜5,901 |   1,130.64〜5,789.99 |
| 100 / 10%失敗   |        46.69〜92.51 |          3〜6 |       1,621〜2,677 |   1,668.15〜2,768.86 |
| 100 / 10%未応答 |      105.49〜119.76 |          3〜6 |       1,104〜1,136 | 30,106.51〜30,738.17 |

ACK全台は未応答条件では応答予定90%を指す。500ms間隔のDB読み取りとAPI読み取りの順序は独立なので、DB可視化の初回観測が集約終端の初回観測より後になる場合もある。全件応答はCOMPLETED、失敗・未応答はそれぞれ90%成功＋10% EXECUTION_FAILED / UNRESPONSIVEでPARTIALLY_FAILEDとなった。未応答でもbacklogは最終的に0へ戻り、再送を含む初回以外の試行は別に保存した。

100台の受付区間は、lock・検証4.419〜11.775ms、operation作成1.559〜3.331ms、command作成11.326〜34.913ms、outbox作成9.053〜28.478ms、target作成5.133〜17.190ms、audit/checkpoint/commit 13.249〜30.228msだった。各区間の最小・最大は別試行なので足して総時間にはしない。

100台ではPostgreSQLの観測最大CPUは試行ごと45.07〜114.51%、memoryは56.89〜61.27MiB、接続数は最大16（上限100）、待機lockは最大4、deadlockは0だった。全件応答3回目はpublish完了5.577秒・詳細p95 169.42msと遅く、その間にlock待機も観測した。これだけで単一の原因や最大能力を断定しない。応答器は100台でCPU観測最大36.19%、RSS最大約95.8MiB、event loop p95最大14.17ms・最大遅延332.92msで、エラーはなかった。応答器側の揺らぎも含むローカル経路の値であり、生成側が無制限に増やせる証明ではない。

ANALYZE後の本番詳細SQLのEXPLAIN実行時間は10台0.358〜1.851ms、100台1.294〜7.651ms。小さい単一operationの表ではSeq ScanとHash Joinが選ばれ、集約・pageにCTE Scan、Sort、Limitを使った。小表の全走査を索引欠落と断定して追加索引は作っていない。EXPLAINは計測終了後の別実行で、HTTP応答時間や冷キャッシュ時間ではない。長期の複数operation履歴や同時複数groupの負荷は未検証。

### 1,000台の追加確認

100台の全必須条件が基準を満たしたため、commit `1848fd6`の同一条件で全件応答を3回追加確認した。初回は追加チェック未達で自動停止したため、結果を確認してから新しいdirectoryで1試行ずつ2回再実行した。`fleet-146-results.json`のrepetitionはこの通算番号で、raw結果のsourceTrialは各起動の試行番号1を保持する。

| 追加試行 |  受付 ms | 詳細p50 / p95 / p99 ms | 成功 / 期限切れ | API失敗 / timeout | 終端初回観測 ms |
| -------- | -------: | ---------------------: | --------------: | ----------------: | --------------: |
| 1        | 3,307.24 | 12.71 / 71.82 / 285.56 |       900 / 100 |             1 / 1 |       30,776.92 |
| 2        |   381.24 |  12.55 / 31.95 / 89.43 |       1,000 / 0 |             0 / 0 |       11,742.41 |
| 3        |   332.50 |  11.36 / 27.27 / 31.13 |       1,000 / 0 |             0 / 0 |        8,524.53 |

各試行ともtarget/command/outboxは1,000件で欠損0、DB接続数最大16、deadlock 0、generatorエラー0だった。初回は900件だけがpublishされ、最後の初回publish記録はcommand作成から29.904秒。残り100件は未送信のまま開始期限切れになった。詳細probeの失敗率は1/300=0.333%で、追加のtimeout 0チェックと期待した全件成功チェックは未達。期限切れを作成欠損や機体の実行失敗とは扱わない。

初回の受付repositoryは3,160.86msで、outbox作成1,282.77msとaudit/commit 1,652.33msが大きかった。Docker CPU観測最大はAPI393.97%、応答器180.21%、DB112.80%。応答器のevent loop最大遅延も約1,445msあり、生成側・API側双方に揺らぎが見られた。同一ホスト上の標本だけで原因を片方へ帰属させない。2・3回目のunique publishは86.96 / 122.99件/s、1,000台全ACKのDB可視化は11,556 / 8,413ms。初回の全ACK可視化は未達なのでnullとし、成功した900台だけを全件完了として表示しない。

詳細SQLのEXPLAIN実行時間は2.925〜4.377ms。3回中2回の成功を根拠に1,000台の安定対応とはしない。通常の上限100を維持し、1,000台の失敗・未応答条件や継続command容量は未検証とする。追加の改善を行う場合は、受付内の大きな区間、直列outbox・都度MQTT接続と30秒期限、生成側の資源を切り分け、今回と同条件で再測定する。今回は期限延長や配送実装の変更で失敗を隠す調整はしていない。

## 保存した結果

- [全21試行の集約JSON](fleet-146-results.json): 試行ごとの受付区間、API分布・error/timeout、publish、ACK、終端、行数、資源と判定。失敗した1,000台初回も含む。
- [raw結果と全query plan](fleet-146-results.tar.gz): 4つの実行directory、environment、試行ごとのDB時系列・command時刻・応答器イベント、Docker stats、全EXPLAINを保存した。展開後に同じ集約scriptで確認できる。

```sh
fleet_report_directory=$(mktemp -d)
tar -xzf docs/load-testing/fleet-146-results.tar.gz -C "$fleet_report_directory"
node scripts/summarize-fleet-load.mjs "$fleet_report_directory/fleet-146-matrix"
```

AWSは使っていないため、この検証によるAWSリソース作成・接続・追加料金はない。全専用Composeと使い捨てDB/volumeは終了時に削除し、機械可読な結果は残した。

## 検証

`pnpm check`は689件成功、DB等の条件付き116件skip。専用PostgreSQLで`DATABASE_INTEGRATION=true pnpm api:test:integration`は66件成功、既存の条件付き1件skip。受付計測出力が失敗してもcommitを保持するテスト、シナリオの判定、percentile、資源集約、DB可視化の観測テストを含む。DB結合テスト専用のDBは削除した。画面・通信仕様・DB schemaは変更していない。
