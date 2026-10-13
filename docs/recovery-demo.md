# v0.3.0の復旧デモと運用上の制約

## 何を確認するか

起動済みsimulatorの通信を切り、SQLiteへの蓄積、プロセス停止後の保持、broker復旧後の旧session再送と新sessionの生成を確認する。AWSや実機には接続しない。

自動で全境界を確認する場合は、依存パッケージをインストールして次を実行する。結果とログは`recovery-results/`に残り、試験用コンテナ・volume・networkは自動で片付く。詳細は[復旧E2E](recovery-e2e.md)を参照する。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test:recovery
```

## 手動で通信断から復旧する

Docker Engine / Compose v2とcurlを用意し、リポジトリのルートで、以下を同じbash / zshのターミナルから実行する。`.env`の作成は不要である。通常の開発環境とは別のprojectとvolumeを使う。

### 1. 試験環境を起動する

```bash
demo_project="recovery-demo-$(date +%Y%m%d-%H%M%S)"
dc() {
  docker compose --env-file /dev/null -f compose.recovery.yaml \
    -p "$demo_project" "$@"
}
dc up --build -d --wait postgres mqtt migrate telemetry-ingestor api simulator probe
api_address="$(dc port api 3000)"
curl --fail --silent "http://${api_address}/devices"
```

初回のbuildには数分かかることがある。APIに`drone-001`とtelemetryが現れるまで数秒待つ。この専用構成は1台・300ミリ秒間隔・1000行上限・最短20ミリ秒の再送で、通常構成の既定値とは違う。ダッシュボードは起動しない。

SQLiteを読む関数を定義する。観測用probeからread-onlyで開くため、simulatorを停止した後も確認できる。

```bash
inspect_buffer() {
  dc exec -T probe node --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/workspace/simulator-data/drone-001.sqlite', { readOnly: true });
try {
  db.exec('PRAGMA busy_timeout=5000');
  console.log(JSON.stringify({
    usage: db.prepare('SELECT count(*) AS rows, coalesce(sum(payload_bytes),0) AS bytes FROM telemetry_buffer').get(),
    sessions: db.prepare('SELECT session_id, count(*) AS rows, min(sequence) AS first_sequence, max(sequence) AS last_sequence FROM telemetry_buffer GROUP BY session_id').all(),
    discards: db.prepare('SELECT count, first_session_id, first_sequence, last_session_id, last_sequence, reason, occurred_at FROM telemetry_discards ORDER BY id').all()
  }, null, 2));
} finally { db.close(); }
NODE
}
```

### 2. brokerを止め、蓄積を確認する

```bash
dc stop --timeout 3 mqtt
sleep 3
inspect_buffer
```

`usage.rows`が増え、`sessions`に停止前の`session_id`と未確認sequenceの範囲が表示される。何度か実行して、通信断中も生成・保存が続くことを確認する。PUBACK済みでもreceipt未確認の行が含まれることがある。これは未確認件数であり、DB未保存件数と同じではない。

長く放置するとこの構成でも容量を超える。`discards`が空の短時間デモで、容量内の復旧と上限超過を混同しない。

### 3. simulatorを強制停止する

```bash
dc kill --signal SIGKILL simulator
dc ps -a simulator
inspect_buffer
```

simulatorが終了したことを確認し、旧`session_id`、行数、最終sequenceを控える。停止後に再度読んでも残件は消えない。プロセス停止中は新しいサンプルを生成しないので、その時間のサンプルは存在しない。

### 4. brokerとsimulatorを復旧する

```bash
dc up -d --wait --no-deps mqtt
dc start simulator
sleep 3
inspect_buffer
dc exec -T --interactive=false postgres psql -U recovery -d recovery -c \
  "SELECT session_id, count(*) AS saved, count(DISTINCT sequence) AS unique_sequences, min(sequence), max(sequence) FROM telemetry WHERE device_id='drone-001' GROUP BY session_id ORDER BY session_id;"
```

`inspect_buffer`を数回実行し、控えた旧sessionが残件から消えることを確認する。一致するDB保存receiptで消えた行であり、ブローカーのPUBACKだけで削除したわけではない。新規生成は続くため、全体の`rows=0`を必須にしない。

PostgreSQLでは旧sessionの範囲が保存され、再起動後の別sessionが`sequence=0`から始まる。各sessionの`saved`と`unique_sequences`が一致し、短時間・破棄なしの場合は`saved = max(sequence) + 1`になることを確認する。より厳密な識別子・本文の照合、意図的な重複配送、command送信前後のAPI停止、期限切れ、容量超過は`pnpm test:recovery`で検証する。

再送の診断には`dc logs --tail 100 simulator telemetry-ingestor`を使う。brokerの復旧だけで即座に残件が消えるとは限らない。再接続バックオフ、DB保存、receipt経路の回復を待つ。simulatorの初回接続失敗時は起動が終了するため、broker停止中の初回起動成功はこのデモの対象外である。

### 5. 終了する

保存を残す場合は`dc down`だけを実行する。完全に片付ける場合は、必要なログを控えてから次を実行する。今回の専用projectのDB・SQLiteは削除され、復元できない。通常の開発projectのvolumeは対象にしない。

```bash
dc --profile limited down --volumes --remove-orphans
docker image rm "${demo_project}-runtime"
```

同じターミナルで定義した`demo_project`を使う。他の環境に対する`down --volumes`や、共有image・volumeの一括削除は行わない。

## 設定と容量の考え方

以下は通常の既定値であり、デモ専用の値ではない。環境変数は[環境変数一覧](environment.md)、詳細な状態遷移は[telemetry receipt](telemetry-receipts.md)と[command永続化](command-durability.md)を参照する。

| 設定 | 既定値 | 意味 |
| --- | --- | --- |
| `TELEMETRY_INTERVAL_MS` | 5000 ms | 機体ごとの生成間隔 |
| `TELEMETRY_BUFFER_DIR` | `simulator-data` | ホスト起動時のSQLite配置先。通常Composeは`/workspace/simulator-data`を永続volumeに置く |
| `TELEMETRY_BUFFER_MAX_ROWS` | 10000 | 機体ごとの未確認行数上限 |
| `TELEMETRY_BUFFER_MAX_BYTES` | 33554432（32 MiB） | 保存JSONのUTF-8バイト数上限。物理ファイルサイズではない |
| `TELEMETRY_RETRY_BASE_MS` / `TELEMETRY_RETRY_MAX_MS` | 1000 / 30000 ms | 再接続・失敗時の指数バックオフ。各回上限の50〜100%のjitterを付ける |
| `TELEMETRY_REPLAY_INTERVAL_MS` | 200 ms | 保存確認後も守る最短送信間隔 |
| `TELEMETRY_PUBLISH_TIMEOUT_MS` | 10000 ms | PUBACK待ち上限、PUBACK後のreceipt再試行の最小待機時間 |
| `COMMAND_HISTORY_RETENTION_MS` | 604800000 ms（7日） | 期限からの履歴保持期間。次のcommand受信時に古い終端行を掃除する |
| `COMMAND_HISTORY_MAX_ROWS` | 10000 | 機体ごとのcommand履歴上限。期限切れ終端行は保持期間より早く消す場合がある |
| `COMMAND_CLOCK_TRUSTED` | `true` | 同期済みUTC時刻を運用側で確認した前提。`false`では新規操作を拒否する |
| commandの`expiresAt` | 作成から30秒 | 操作開始の締切。固定値であり環境変数による変更は未実装 |
| `COMMAND_OUTBOX_POLL_MS` | 250 ms | outbox確認間隔 |
| `COMMAND_OUTBOX_RETRY_BASE_MS` / `COMMAND_OUTBOX_RETRY_MAX_MS` | 1000 / 8000 ms | outbox再送の指数バックオフとjitter |
| `COMMAND_OUTBOX_MAX_ATTEMPTS` | 5 | 接続・publish試行回数の上限 |

telemetryの保持期間を時間で設定する機能はない。未確認行はreceiptか容量超過まで残る。PostgreSQLのtelemetry・重複排除情報と終端outbox、SQLiteの破棄記録にも自動の時限削除を設けていない。物理ディスクの使用量は別に監視する。

1件の保存JSONを平均`S`バイト、生成間隔を`I`秒とすると、保持可能行数の目安は`N = min(MAX_ROWS, floor(MAX_BYTES / S))`である。既存残件を`B`とすると、通信断中に新規生成を保持できる時間の目安は`max(0, N - B) × I`秒になる。既定の行上限・5秒間隔・残件なしなら約13.9時間だが、JSONが大きければバイト上限が先に効く。これは容量計画の概算であり、保持保証の時間や実測値ではない。直ちに生成する初回行、サイズの変動、ディスク空き容量、安全余裕を別に考慮する。

機体ごとに1行のreceiptを待つため、再送速度の理論上限は既定200 msで5件/秒であり、実際にはDB・ネットワーク・再試行の待機で低くなる。新規生成速度`λ=1/I`に対し、実測した保存確認速度`μ`が`λ`を上回らなければ残件は減らない。`μ > λ`なら解消時間の目安は`B / (μ - λ)`秒である。多数機体が同時に復旧するとDB負荷と通信量が増えるため、最短再送間隔だけから実効性能を断定しない。

## 配送保証と失われる条件

保証の起点はtelemetryのSQLite commitである。容量内で永続領域が保たれ、通信・DB・receipt経路が最終的に回復する条件で、PostgreSQLまでat-least-onceで保存する。同じ識別子・同じ本文の再送は重複行を作らずreceiptを再通知するが、exactly-once配送や実機操作のexactly-once実行ではない。

- 容量超過: 最古の未確認行を破棄する。1行がバイト上限を超える場合は新しい行を保存しない。理由・件数・先頭と末尾の識別子・発生時刻は同じSQLite transactionで記録する。
- 長期切断・receipt障害: 接続だけが復旧しても保存確認がなければ行を消さない。生成を続けて上限を超えると欠損する。
- ディスク障害・volume消失: SQLite保存エラーで生成を止める。破損したDBを自動修復する機能はない。volumeを消せばtelemetry原本とcommand重複防止履歴も失う。
- プロセス停止: SQLite commit前の生成途中サンプルと停止中の時間のサンプルは保持しない。既にcommitした未確認行は再起動後も対象にする。
- 時計ずれ: 期限は端末UTC時刻に依存する。時刻が遅いと本来の期限後に開始し得る。OSの同期状態や再起動をまたぐずれは自動判定しない。同期を確認できなければ`COMMAND_CLOCK_TRUSTED=false`にする。
- commandの期限・試行上限: API受付だけでは配送・操作を保証しない。未試行の期限切れはEXPIRED、試行後の結果不明はTIMED_OUT、PUBACKなしで上限ならFAILEDになる。有効な後着ACKの扱いは[ADR 0005](adr/0005-delivery-and-recovery.md)に従う。
- 操作開始後の停止: SQLiteにSTARTEDがあり結果がなければUNCERTAINとして自動再実行しない。APIのACKNOWLEDGEDは受領であって操作成功ではなく、UNCERTAINは端末SQLiteとログで追う。
- HTTPの応答欠落: command保存後に202を受け取れない場合もある。再度POSTすると別commandIdが作られるため、履歴を確認せず新しい操作を送らない。HTTP受付のidempotency keyは未実装である。

SQLiteの`.sqlite`だけを動作中にコピーしない。SQLite対応のbackup手順、または正常停止後のvolume全体の保存など、WALも含めた整合性を確保する。PostgreSQLとSQLiteは別々の永続領域であり、一方の削除・復元だけで状態が一致するとは限らない。

運用ではSQLite残件・最古時刻・破棄記録、ディスク空き、DB保存失敗・内容衝突のログを確認する。APIの`GET /command-outbox/status`は滞留件数・最古時刻・累計試行数・失敗数を返す。simulatorの残件を返すHTTP APIや自動アラートは未実装で、このデモではread-only SQLite観測を使う。

復旧直後は古い計測値を再送するため、最新の受信時刻だけで計測が新しいとは判断しない。device timestampとサーバー受信時刻、接続状態と飛行状態を区別する。

## 検証済みの範囲

2026年10月13日にmacOS / OrbStackで上記の手動コマンドを掲載順に実行した。強制停止後の残件12行（旧sessionのsequence 3〜14）が保持され、復旧後に旧sessionの0〜14の15行、新sessionの0〜10の11行をDBで確認した。各sessionの保存件数と一意sequence数は一致し、旧sessionのSQLite残件は0になった。生成を続ける新sessionには未確認1行が残ったため、全体のrows=0は合格条件にしていない。最後に専用コンテナ・volume・network・image tagの削除を確認した。件数はこの実行の実測値であり、次回も同じになるとは限らない。

[#115 / PR #133](https://github.com/wmsuke/drone-fleet-platform/pull/133)のローカル実測値と停止境界は[復旧E2Eの検証記録](recovery-e2e.md#ローカルの検証記録)を参照する。説明できない欠損・DB重複なし、記録済みの容量超過欠損、同じcommandの再送、重複・期限切れ操作の拒否とUNCERTAIN復旧を確認した。STARTED直後のケースは停止境界fixtureであり、実機の物理操作を試験したものではない。

AWSでは[2026年10月5日のPhase 2経路](aws/e2e.md#2026-10-05の実行結果)と[#64の100台クラウド経路](load-testing/aws-iot-free-tier.md)を確認した記録がある。ただしv0.3.0のreceipt・永続バッファ・outboxを組み合わせた実AWSの障害注入は未検証である。過去の通常経路や負荷生成器の結果で、この復旧試験を代替しない。今回のデモはAWS接続・リソース変更・課金を伴う試験を行わない。
