# Drone Fleet Platform

ドローンの状態監視と遠隔コマンドを扱うデバイス管理基盤。

まずはTypeScriptで作った仮想ドローンからMQTTでデータを送り、位置やバッテリー残量、接続状態をダッシュボードで確認できるようにする。その後、AWS IoTとの接続、通信断からの復旧、OTA、ROS 2との連携を追加していく。

## 開発状況

開発基盤を整えるPhase 0は完了した。現在は次の範囲を利用できる。

- pnpm workspaceとTypeScriptの共通設定
- lint、型チェック、テスト、ビルドの共通コマンド
- GitHub Actionsによる品質チェックとシークレット検査
- Docker Composeで動かすローカル開発用Mosquitto
- MQTTの送受信検証

各アプリと`packages/protocol`、`packages/database`はまだプレースホルダーである。仮想ドローン、テレメトリ受信・保存、HTTP API、ダッシュボード、遠隔コマンドはPhase 1で実装する。現時点では画面や全サービスの起動手順はない。

## 開発環境

次のツールを使用する。

- Node.js 22以上
- Corepackから有効化するpnpm 10以上
- Docker Engine
- Docker Compose v2

バージョンは次のコマンドで確認できる。

```bash
node --version
pnpm --version
docker --version
docker compose version
```

### セットアップ

リポジトリをcloneした後、ルートで依存関係をインストールし、共通の品質チェックを実行する。`packageManager`で指定したpnpmと、リポジトリのlockfileを使用する。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

ローカルサービス用の設定項目を確認する場合は、サンプルをコピーする。

```bash
cp .env.example .env
```

サンプル値はローカル開発専用であり、Phase 0のコードはこれらの変数を読み込まない。そのため、MQTTの送受信検証に`.env`は必要ない。設定項目と秘密情報の扱いは[環境変数と秘密情報](docs/environment.md)を参照する。

個別のコマンドは次のとおり。

| コマンド           | 内容                                       |
| ------------------ | ------------------------------------------ |
| `pnpm check`       | lint、型チェック、テスト、ビルドを順に実行 |
| `pnpm lint`        | ESLintとPrettierによる静的検査             |
| `pnpm typecheck`   | 全workspaceの型チェック                    |
| `pnpm test`        | Vitestによるテスト                         |
| `pnpm build`       | 全workspaceのビルド                        |
| `pnpm verify:mqtt` | Mosquittoの起動とMQTT送受信を検証          |

Pull Requestと`main`ブランチへのpushでは、GitHub Actionsが依存関係をインストールし、`pnpm check`を実行する。

Phase 0ではテスト対象の機能がまだないため、テストが0件でも`pnpm test`は成功する。これは開発コマンドを実行できることを確認するための一時的な扱いであり、各workspaceの機能がテスト済みであることを意味しない。機能を実装するIssueでは、外部から確認できる振る舞いのテストを追加する。

### Phase 0の確認結果

Phase 0完了時に次の環境とコマンドで確認した。バージョンは検証時点の記録であり、前提条件の下限を変更するものではない。

| 項目                                       | 確認結果          |
| ------------------------------------------ | ----------------- |
| Node.js                                    | v22.22.3          |
| pnpm                                       | 10.28.1           |
| Docker Engine                              | 28.0.4            |
| Docker Compose                             | v2.34.0-desktop.1 |
| `pnpm install --frozen-lockfile`           | 成功              |
| `pnpm check`                               | 成功（テスト0件） |
| `pnpm verify:mqtt`                         | 成功              |
| `docker compose ps` / `logs mqtt` / `down` | 成功              |

## ローカルMQTTブローカー

Docker ComposeでMosquittoを起動する。現在のCompose構成に含まれるのはMQTTブローカーのみで、仮想ドローンや他のサービスは起動しない。

```bash
docker compose up -d mqtt
docker compose ps
```

ブローカーのログを確認する場合は次のコマンドを使用する。`-f`を付けるとログを継続的に表示できる。

```bash
docker compose logs mqtt
docker compose logs -f mqtt
```

ローカル開発だけで利用するため、`localhost:1883`で匿名接続を許可している。外部へ公開した環境では使用しない。

起動、検証専用トピックの購読と送信、受信内容の検証をまとめて実行するには、次のコマンドを使用する。送受信を確認できない場合は終了コードが非0になる。検証後もMosquittoは起動したままになるため、不要になったら後述のコマンドで停止する。

```bash
pnpm verify:mqtt
```

手動で確認する場合は、最初のターミナルで購読を開始する。

```bash
docker compose exec mqtt mosquitto_sub -h localhost -t fleet/test
```

別のターミナルからメッセージを送信すると、購読側に`hello`が表示される。

```bash
docker compose exec mqtt mosquitto_pub -h localhost -t fleet/test -m hello
```

確認後はブローカーを停止する。

```bash
docker compose down
```

保存データも削除する場合は、代わりに次のコマンドを使用する。

```bash
docker compose down --volumes
```

アプリの起動方法は実装後に記載する。Phase 1では、`docker compose up`で全サービスを起動できる構成を目指す。

## 設計と開発計画

- [システム構成](docs/architecture.md)
- [通信仕様](docs/protocol.md)
- [ロードマップ](docs/roadmap.md)
- [環境変数と秘密情報](docs/environment.md)
- [開発ルール](AGENTS.md)
- [ADR 0001: pnpmでTypeScriptのモノレポを構成する](docs/adr/0001-monorepo.md)
- [ADR 0002: デバイスとの通信にMQTTを使う](docs/adr/0002-mqtt-protocol.md)
- [ADR 0003: 初期の保存先にPostgreSQLを使う](docs/adr/0003-database.md)

## ライセンス

このプロジェクトは[MIT License](LICENSE)の下で公開している。
