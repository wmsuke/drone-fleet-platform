# 環境変数と秘密情報

ローカル開発で使用する環境変数と、秘密情報をリポジトリへ含めないための扱いを定める。

## ローカル環境の準備

リポジトリのルートでサンプルをコピーする。

```bash
cp .env.example .env
```

`.env.example`にはローカル開発用のダミー値だけを置く。コピー後の`.env`はGitの管理対象外であり、必要に応じて各自の環境で値を変更する。

現在の変数は、Docker Composeと各サービスで共有するローカル構成の初期値である。Compose内ではPostgreSQLとMosquittoの接続先をサービス名へ上書きする。シミュレータをホストから`node --env-file=.env`で起動する場合は、ルートの`.env`からMQTT接続先とシミュレータ設定を読み込む。DBマイグレーションも同じ`.env`からPostgreSQL接続設定を読み込む。

## 設定項目

| 変数 | 用途 |
|---|---|
| `POSTGRES_HOST` | PostgreSQLのホスト名 |
| `POSTGRES_PORT` | PostgreSQLのTCPポート |
| `POSTGRES_DB` | PostgreSQLのデータベース名 |
| `POSTGRES_USER` | PostgreSQLのユーザー名 |
| `POSTGRES_PASSWORD` | PostgreSQLのパスワード |
| `MQTT_TRANSPORT` | simulator、telemetry-ingestor、APIのMQTT transport（`local`または`aws-iot`） |
| `MQTT_HOST` | MQTTブローカーのホスト名 |
| `MQTT_PORT` | MQTTブローカーのTCPポート |
| `OFFLINE_TIMEOUT_MS` | 最終受信からオフラインと判定するまでの時間 |
| `TELEMETRY_BATCH_SIZE` | telemetryをDBへ保存する1バッチの最大件数（既定値: `100`） |
| `TELEMETRY_FLUSH_INTERVAL_MS` | 未満バッチをDBへ保存する最大待機時間（既定値: `50`） |
| `TELEMETRY_MAX_BUFFER_SIZE` | 保存待ち・保存中telemetryの上限件数（既定値: `10000`） |
| `LOAD_METRICS_ENABLED` | telemetry-ingestorの負荷試験メトリクスを有効にするか |
| `LOAD_TEST_ID` | 負荷試験を識別するID |
| `LOAD_SESSION_ID` | 負荷生成器またはingestorプロセスを識別するセッションID |
| `LOAD_METRICS_REPORT_PATH` | ingestorの負荷試験レポート保存先 |
| `LOAD_GENERATOR_REPORT_PATHS` | 集約するgeneratorレポートのパス（カンマ区切り） |
| `LOAD_INGESTOR_REPORT_PATHS` | 集約するingestorレポートのパス（カンマ区切り） |
| `LOAD_AGGREGATE_REPORT_PATH` | 集約レポートの保存先 |
| `API_HOST` | HTTP APIの待受ホスト |
| `API_PORT` | HTTP APIの待受ポート |
| `DASHBOARD_ORIGIN` | APIがCORSで許可するダッシュボードのorigin |
| `VITE_API_BASE_URL` | ダッシュボードが接続するHTTP APIのベースURL |
| `DASHBOARD_PORT` | Composeがホストへ公開するダッシュボードのポート |
| `DRONE_COUNT` | シミュレータが起動する仮想ドローンの台数 |
| `DEVICE_ID_PREFIX` | シミュレータが生成するdeviceIdの接頭辞 |
| `SIMULATION_SEED` | シミュレータの状態系列を再現するシード |
| `TELEMETRY_INTERVAL_MS` | テレメトリの送信間隔（ミリ秒） |
| `AWS_IOT_ENDPOINT` | AWS IoT CoreのATS endpoint |
| `AWS_IOT_ROOT_CA_PATH` | Amazon Root CAファイルのパス |
| `AWS_IOT_DEVICE_CREDENTIALS_DIR` | deviceId別の証明書・秘密鍵directoryを置く親directory |
| `AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID` | telemetry-ingestor用IoT Policyと一致する固定clientId |
| `AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH` | telemetry-ingestor専用クライアント証明書のパス |
| `AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH` | telemetry-ingestor専用秘密鍵のパス |
| `AWS_IOT_API_CLIENT_ID` | API用IoT Policyと一致する固定clientId |
| `AWS_IOT_API_CERTIFICATE_PATH` | API専用クライアント証明書のパス |
| `AWS_IOT_API_PRIVATE_KEY_PATH` | API専用秘密鍵のパス |

値と値ごとの説明は`.env.example`を正とし、この文書へ重複して記載しない。サンプルの`POSTGRES_HOST`と`MQTT_HOST`は、ホストOSから各サービスへ接続する値である。Compose内のアプリには、接続先をそれぞれ`postgres`と`mqtt`として渡す。通常の一括起動ではPostgreSQLとMosquittoをホストへ公開しない。ホスト側の開発コマンドから接続するときだけ`compose.dev.yaml`を併用する。接続URLは各サービスの起動時にこれらの値から組み立て、ユーザー名やパスワードを別の環境変数へ重複して記載しない。AWS IoT Coreへの切替手順は[シミュレータ](aws/simulator.md)、[telemetry-ingestor](aws/telemetry-ingestor.md)、[API](aws/api.md)、[E2E](aws/e2e.md)の文書を参照する。

## 秘密情報の扱い

- `.env`、`.env.local`など、`.env.example`以外の環境ファイルはコミットしない。
- パスワード、APIキー、秘密鍵、証明書などの実値を`.env.example`、ログ、テストデータ、Issue、PRへ記載しない。
- 新しい環境変数を追加するときは、`.env.example`へ安全なダミー値と説明を追加し、この文書の一覧も更新する。
- 誤って秘密情報をコミットした場合は、履歴から削除するだけでなく、該当する認証情報を直ちに失効またはローテーションする。
- CIや実環境では、環境ごとのsecret管理機能から値を渡す。リポジトリ内のファイルを認証情報の配布手段にしない。

証明書、秘密鍵、およびそれらを置く`certs/`と`secrets/`は、配置場所にかかわらず`.gitignore`で除外する。公開用の証明書などを管理対象にする必要が生じた場合も、例外は用途と理由をレビューしてから個別に追加する。

## Secret scan

Gitleaks 8.28.0で作業ツリーと全Git履歴を検査する。

```bash
./scripts/scan-secrets.sh
```

ローカルでは`gitleaks`コマンドを優先し、存在しない場合はDockerイメージ`zricethezav/gitleaks:v8.28.0`を使用する。検出内容をログへ露出しないよう、常に`--redact`を指定する。Pull Requestと`main`へのpushでは、`.github/workflows/secret-scan.yml`が同じスクリプトを実行する。

### 検査記録

2026-09-25に、秘密鍵ヘッダーとAWS、GitHub、Slackの代表的なcredential形式を正規表現で補助検査した。これはGitleaksの代替ではないため、Pull Requestのworkflowでも検査する。

| 対象 | コマンド | 結果 |
|---|---|---|
| current tree | `git grep -I -n -E <credential-patterns> -- .` | 検出なし |
| Git history（全参照） | `git log --all -p --no-ext-diff --unified=0`の出力を同じ形式で検査 | 検出なし |

記録は検査時点の結果であり、以後の変更はCIで再検査する。

### GitHubのsecret detection

GitHubのSecret scanningおよびPush protectionは、管理権限のない現在の作業環境からRepository settingsを参照できない。このため、利用可否と設定状態はいずれも**未確認**であり、設定済みとは扱わない。リポジトリ管理者は`Settings > Security > Code security and analysis`で利用可否と有効状態を確認し、有効化できる場合は両方を有効にする。GitHub側の設定に依存せず検査を必須にするため、上記のGitleaks workflowを使用する。
