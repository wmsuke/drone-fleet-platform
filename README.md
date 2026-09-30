# Drone Fleet Platform

ドローンの状態監視と遠隔コマンドを扱うデバイス管理基盤。

まずはTypeScriptで作った仮想ドローンからMQTTでデータを送り、位置やバッテリー残量、接続状態をダッシュボードで確認できるようにする。その後、AWS IoTとの接続、通信断からの復旧、OTA、ROS 2との連携を追加していく。

## 開発状況

開発基盤を整えるPhase 0は完了し、Phase 1の機能実装を進めている。現在は次の範囲を利用できる。

- pnpm workspaceとTypeScriptの共通設定
- lint、型チェック、テスト、ビルドの共通コマンド
- GitHub Actionsによる品質チェックとシークレット検査
- Docker Composeで動かすローカル開発用Mosquitto
- MQTTの送受信検証
- MQTTトピックとPhase 1メッセージの型・実行時検証
- 台数を設定できる仮想ドローンからの接続状態・テレメトリ送信・コマンド処理
- PostgreSQLへのデバイス登録とテレメトリ保存、オンライン・オフライン判定
- 登録済みデバイスの一覧・詳細API

テレメトリ履歴・コマンド送信のAPIと`apps/dashboard`は後続Issueで実装する。現時点では画面や全サービスの一括起動手順はない。

## 開発環境

次のツールを使用する。

- Node.js 22以上
- Corepackから有効化するpnpm 10以上
- Docker Engine
- Docker Compose v2

Corepackを有効化し、各ツールのバージョンを確認する。

```bash
node --version
corepack enable
pnpm --version
docker --version
docker compose version
```

### セットアップ

リポジトリをcloneした後、ルートで依存関係をインストールし、共通の品質チェックを実行する。`packageManager`で指定したpnpmと、リポジトリのlockfileを使用する。

```bash
pnpm install --frozen-lockfile
pnpm check
```

ローカルサービス用の設定項目を確認する場合は、サンプルをコピーする。

```bash
cp .env.example .env
```

サンプル値はローカル開発専用である。シミュレータは起動時に`.env`からMQTT接続先、deviceId、送信間隔を読み込む。ブローカー単体の送受信検証に`.env`は必要ない。設定項目と秘密情報の扱いは[環境変数と秘密情報](docs/environment.md)を参照する。

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

`pnpm test`は通信仕様とシミュレータの単体テストを実行する。未実装workspaceにはまだテストがない。

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

### 仮想ドローンの起動

`.env.example`をコピーし、Mosquittoを起動する。

```bash
cp .env.example .env
docker compose up -d mqtt
```

最初のターミナルで全機体のテレメトリを購読する。`-v`によりトピックへ含まれるdeviceIdを識別できる。

```bash
docker compose exec mqtt mosquitto_sub -v -h localhost \
  -t 'fleet/v1/devices/+/telemetry'
```

別のターミナルでシミュレータを起動する。`DRONE_COUNT`の既定値は10で、`drone-001`から`drone-010`が起動する。各機体は起動直後にONLINEとテレメトリを送信し、以後は約5秒ごとにテレメトリを送信する。

```bash
pnpm --filter @drone-fleet/simulator... build
node --env-file=.env apps/simulator/dist/index.js
```

台数を変更する場合は`.env`の`DRONE_COUNT`へ1〜1000の整数を指定する。不正な値では起動せずエラーを表示する。1000台規模の性能はPhase 1の保証対象外とする。

シミュレータを`Ctrl+C`で終了すると、全機体がOFFLINE / SHUTDOWNをretain付きで送信してからMQTT接続を閉じる。購読側のJSONは`packages/protocol`の`connectionStatusMessageSchema`と`telemetryMessageSchema`で検証できる。

確認後はブローカーを停止する。

```bash
docker compose down
```

保存データも削除する場合は、代わりに次のコマンドを使用する。

```bash
docker compose down --volumes
```

### PostgreSQLの起動と初期化

`.env.example`をコピーし、空のPostgreSQLを起動する。

```bash
cp .env.example .env
docker compose up -d --wait postgres
```

Drizzleのマイグレーションを適用する。再実行しても適用済みのマイグレーションは重複実行されない。

```bash
pnpm db:migrate
```

DB制約を含むintegration testは、PostgreSQL起動後に次のコマンドで実行する。

```bash
DATABASE_INTEGRATION=true pnpm db:test:integration
```

MQTT受信処理のテレメトリ保存を実DBで確認する場合は、次のintegration testを実行する。テスト内で既存デバイスを用意し、有効なテレメトリだけが保存されることを確認する。

```bash
DATABASE_INTEGRATION=true pnpm telemetry:test:integration
```

スキーマを変更した場合は、変更内容を確認してから新しいSQLマイグレーションを生成する。

```bash
pnpm db:generate
```

DBを空の状態へ戻す場合は、PostgreSQLを停止してデータ用volumeを削除する。

```bash
docker compose down --volumes
```

Phase 1では、後続Issueで`docker compose up`による全サービスの一括起動を追加する。

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
