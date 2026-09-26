# Drone Fleet Platform

ドローンの状態監視と遠隔コマンドを扱うデバイス管理基盤。

まずはTypeScriptで作った仮想ドローンからMQTTでデータを送り、位置やバッテリー残量、接続状態をダッシュボードで確認できるようにする。その後、AWS IoTとの接続、通信断からの復旧、OTA、ROS 2との連携を追加していく。

## 開発状況

開発基盤を準備している段階。

最初のリリースでは、以下を実装する。

- 仮想ドローン10台からのテレメトリ送信
- デバイスの登録とオンライン・オフライン判定
- 機体一覧と詳細の表示
- 遠隔コマンドの送信と受領確認

## 開発環境

Node.js 22以上とpnpm 10以上を使用する。依存関係をインストールした後、リポジトリのルートで共通の検証コマンドを実行できる。

```bash
corepack enable
pnpm install
pnpm check
```

ローカルサービス用の環境変数は、サンプルをコピーして準備する。

```bash
cp .env.example .env
```

サンプル値はローカル開発専用であり、現在のworkspaceはまだこれらの変数を読み込まない。設定項目と秘密情報の扱いは[環境変数と秘密情報](docs/environment.md)を参照する。

個別のコマンドは次のとおり。

| コマンド         | 内容                           |
| ---------------- | ------------------------------ |
| `pnpm lint`      | ESLintとPrettierによる静的検査 |
| `pnpm typecheck` | 全workspaceの型チェック        |
| `pnpm test`      | Vitestによるテスト             |
| `pnpm build`     | 全workspaceのビルド            |

Phase 0ではテスト対象の機能がまだないため、テストが0件でも`pnpm test`は成功する。これは開発コマンドを実行できることを確認するための一時的な扱いであり、各workspaceの機能がテスト済みであることを意味しない。機能を実装するIssueでは、外部から確認できる振る舞いのテストを追加する。

## ローカルMQTTブローカー

Docker ComposeでMosquittoを起動する。現在のCompose構成は開発基盤用のMQTTブローカーのみを含む。

```bash
docker compose up -d mqtt
docker compose ps
```

ローカル開発だけで利用するため、`localhost:1883`で匿名接続を許可している。外部へ公開した環境では使用しない。

送受信を確認するには、最初のターミナルで購読を開始する。

```bash
docker compose exec mqtt mosquitto_sub -h localhost -t fleet/test
```

別のターミナルからメッセージを送信すると、購読側に`hello`が表示される。

```bash
docker compose exec mqtt mosquitto_pub -h localhost -t fleet/test -m hello
```

確認後はブローカーを停止する。保存データも削除する場合は`--volumes`を付ける。

```bash
docker compose down
```

アプリの起動方法は実装後に記載する。Phase 1では、`docker compose up`で全サービスを起動できる構成を目指す。

## 設計と開発計画

- [システム構成](docs/architecture.md)
- [通信仕様](docs/protocol.md)
- [ロードマップ](docs/roadmap.md)
- [環境変数と秘密情報](docs/environment.md)
- [開発ルール](AGENTS.md)

## ライセンス

このプロジェクトは[MIT License](LICENSE)の下で公開している。
