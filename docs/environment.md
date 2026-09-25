# 環境変数と秘密情報

ローカル開発で使用する環境変数と、秘密情報をリポジトリへ含めないための扱いを定める。

## ローカル環境の準備

リポジトリのルートでサンプルをコピーする。

```bash
cp .env.example .env
```

`.env.example`にはローカル開発用のダミー値だけを置く。コピー後の`.env`はGitの管理対象外であり、必要に応じて各自の環境で値を変更する。

現在の変数は、後続のDocker Composeと各サービスの実装で使用するローカル構成の初期値である。現時点のworkspaceはこれらを読み込まない。

## 設定項目

| 変数 | 用途 | サンプル値 |
|---|---|---|
| `POSTGRES_DB` | PostgreSQLのデータベース名 | `drone_fleet` |
| `POSTGRES_USER` | PostgreSQLのユーザー名 | `drone_fleet` |
| `POSTGRES_PASSWORD` | PostgreSQLのパスワード | `local-development-only` |
| `DATABASE_URL` | APIとMQTT受信処理が使用するPostgreSQL接続先 | `postgresql://drone_fleet:local-development-only@postgres:5432/drone_fleet` |
| `MQTT_HOST` | MQTTブローカーのホスト名 | `mosquitto` |
| `MQTT_PORT` | MQTTブローカーのTCPポート | `1883` |
| `DRONE_COUNT` | シミュレータが起動する仮想ドローン数 | `10` |

サンプルのホスト名`postgres`と`mosquitto`は、Docker Compose内で使用するサービス名を想定している。ホストOSからサービスを直接起動する場合は、接続可能なホスト名へ変更する。

## 秘密情報の扱い

- `.env`、`.env.local`など、`.env.example`以外の環境ファイルはコミットしない。
- パスワード、APIキー、秘密鍵、証明書などの実値を`.env.example`、ログ、テストデータ、Issue、PRへ記載しない。
- 新しい環境変数を追加するときは、`.env.example`へ安全なダミー値と説明を追加し、この文書の一覧も更新する。
- 誤って秘密情報をコミットした場合は、履歴から削除するだけでなく、該当する認証情報を直ちに失効またはローテーションする。
- CIや実環境では、環境ごとのsecret管理機能から値を渡す。リポジトリ内のファイルを認証情報の配布手段にしない。
