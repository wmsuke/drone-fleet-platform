# システム構成

## 開発範囲

仮想ドローン10台をローカルで動かす構成と、AWS IoT Coreを経由する構成を提供する。各機体からテレメトリを受信・保存し、ダッシュボードで状態を確認する。帰還と再起動のコマンドを送り、受領確認まで追跡する。

Phase 2でAWS接続を追加した。Phase 3ではtelemetryのsessionIdを追加した。通信断中の永続バッファと再送は後続Issueで扱う。配送保証と復旧時の責務は[ADR 0005](adr/0005-delivery-and-recovery.md)に定めた。AWS対応後も、ローカルだけで動作する構成を維持する。

Phase 0でTypeScriptのモノレポ、Mosquitto、共通検証コマンド、CIを整備し、Phase 1でテレメトリ、データ保存、HTTP API、シミュレータ、ダッシュボードを実装した。Phase 2でTerraform、mTLS、機体単位のIoT Policy、各サービスのAWS IoT transport、AWS E2Eを追加した。

## Phase 1のローカル構成

```mermaid
flowchart LR
    Simulator["仮想ドローン ×10"]
    Broker["Mosquitto"]
    Ingestor["MQTT受信処理"]
    DB["PostgreSQL"]
    API["Fleet API"]
    Dashboard["ダッシュボード"]

    Simulator -->|"テレメトリ・接続状態・ACK"| Broker
    Broker --> Ingestor
    Ingestor --> DB
    Dashboard -->|"HTTP"| API
    API --> DB
    API -->|"コマンド送信"| Broker
    Broker -->|"コマンド"| Simulator
```

Phase 1では、Docker Composeで以下を起動する。

- Mosquitto
- PostgreSQL
- シミュレータ
- MQTT受信処理
- API
- ダッシュボード

シミュレータは1つのアプリ内で複数の仮想機体を動かす。機体ごとに異なるdeviceIdとMQTT接続を持たせる。

## 技術スタック

| 領域 | 使用技術 | 状態 |
|---|---|---|
| 言語・実行環境 | TypeScript / Node.js | Phase 0で導入済み |
| モノレポ | pnpm workspace | Phase 0で導入済み |
| HTTP API | Fastify | Phase 1で導入済み |
| 入力検証 | Zod | Phase 1で導入済み |
| データベース | PostgreSQL | Phase 1で導入済み |
| ORM・マイグレーション | Drizzle ORM | Phase 1で導入済み |
| MQTTクライアント | mqtt.js | Phase 1で導入済み |
| MQTTブローカー | Eclipse Mosquitto | Phase 0で導入済み |
| フロントエンド | React / Vite / TanStack Query | Phase 1で導入済み |
| テスト | Vitest | Phase 1の単体・結合テストを実装済み |
| 画面のE2Eテスト | Playwright | 未導入 |
| ローカル実行 | Docker Compose | Phase 1の全サービスに使用 |
| CI | GitHub Actions | Phase 0で導入済み |
| 静的検査・整形 | ESLint / Prettier | Phase 0で導入済み |

導入済みのバージョンは設定ファイルと`pnpm-lock.yaml`に記録する。Phase 1以降の依存ライブラリは、導入時に互換性を確認してバージョンを決める。

## ディレクトリ構成

```text
apps/
├── api/
├── dashboard/
├── load-generator/
├── telemetry-ingestor/
└── simulator/

packages/
├── protocol/
├── database/
└── config/

infra/
├── local/
└── terraform/

docs/
├── adr/
│   ├── 0001-monorepo.md
│   ├── 0002-mqtt-protocol.md
│   ├── 0003-database.md
│   ├── 0004-aws-iot-connection-and-credentials.md
│   └── 0005-delivery-and-recovery.md
├── aws/
├── load-testing/
├── releases/
├── architecture.md
├── environment.md
├── protocol.md
└── roadmap.md

scripts/
├── manage-aws-iot-certificate.mjs
├── scan-secrets.sh
├── test-aws-iot-e2e.sh
├── test-telemetry-path.sh
└── verify-mqtt.sh
```

Phase 0の開発基盤、Phase 1のローカル構成に加え、Phase 2のTerraform、証明書管理、AWS IoT transport、E2Eを実装済みである。

Phase 3の#110では、simulatorがtelemetryを機体ごとのSQLiteに確定してからMQTTへ送る。切断中も生成と保存を続け、再起動後も未確認行を保持する。MQTT送信成功だけでは削除しない。再送、ingestorによる保存確認、確認後の削除は#111以降の対象である。保存先と容量上限は`TELEMETRY_BUFFER_DIR`、`TELEMETRY_BUFFER_MAX_ROWS`、`TELEMETRY_BUFFER_MAX_BYTES`で設定する。上限は機体ごとに行数とJSONの論理バイト数で判定し、最古の行の破棄履歴を同じSQLiteに残す。保存エラー時はその機体の生成を止め、ログとbuffer状態で確認できる。

#111のPRではMQTT切断後の再接続を指数バックオフとjitterで制御し、SQLiteの`published_at`がない行を追加順にQoS 1で送る。復旧中の新規telemetryは末尾に保存し、蓄積分を先に送る。送信間隔と再試行待機時間は設定可能である。PUBACKを得た行は再送対象から外すがSQLiteからは削除しない。現在のingestorは保存確認通知と永続重複排除を実装していないため、PUBACK済みの行がDBへ未保存のまま残り得る。現段階ではSQLiteからPostgreSQLへのat-least-once保存は保証しない。#112のDB重複排除後、#128で全未確認行の再送、receipt待ち、保存確認後の削除を扱う。現在の`backlog`はPUBACK未取得行数であり、SQLiteに残る全未確認行数とは異なる。

### apps/api

デバイス一覧・詳細・テレメトリ履歴・コマンド送信・コマンド履歴APIを実装済みである。一覧は各deviceをdeviceId順で返し、接続状態と最新テレメトリの概要を取得できる。詳細はdeviceの基本情報と最新テレメトリの全項目を返す。テレメトリ履歴は受信時刻、コマンド履歴は作成時刻の新しい順に返し、どちらも既定100件、`limit`で最大1000件まで指定できる。コマンド送信はPENDINGでDBへ保存してからQoS 1、retainなしでMQTTへ送信し、結果をSENTまたはFAILEDへ更新する。状態更新はPENDINGの行だけを対象とし、先に届いたACKによるACKNOWLEDGEDを上書きしない。

- デバイス一覧・詳細の取得
- テレメトリ履歴の取得
- コマンドの受付とMQTT送信
- コマンド履歴の取得（実装済み）

コマンドの送信処理はHTTPの処理から分離するが、初期段階では独立したサービスにはしない。

### apps/telemetry-ingestor

テレメトリ、接続状態、ACKトピックの購読、通信仕様による検証、初回受信時のデバイス登録、テレメトリ保存、LWTと最終受信時刻によるオンライン・オフライン判定、ACKによるコマンド状態更新を実装済みである。telemetry v1/v2を受け付け、v2のsessionIdを検証・保存する。負荷試験のtestIdとレポート用sessionIdはプロセス設定およびJSONレポートで管理し、productionのテレメトリには追加しない。telemetry v2のsessionIdとは別の値である。

- 初回受信時のデバイス登録（実装済み）
- テレメトリの保存（実装済み）
- 接続状態と最終受信時刻の更新
- ACKによるコマンド状態の更新（実装済み）

不正なメッセージは保存せず、原因をログに残す。検証済みテレメトリは件数または最大待機時間で区切った小さなbatchとして1 transactionで保存する。同じbatch内のdevice更新は最新の受信時刻へ集約し、保存待ち・保存中の件数には上限を設ける。batch保存失敗と上限超過はメッセージ単位の失敗としてmetricsとログへ記録する。

計測モードではMQTT受信、protocol検証成功・失敗、DB保存成功・失敗、実際のOFFLINE遷移を別々に数える。device timestampからMQTT受信時刻までの遅延と、MQTT受信からそのメッセージを含むbatch transaction完了までの保存時間も分離する。時間値は固定bucketのヒストグラムとして保持し、メッセージ件数に比例してメモリ使用量が増えないようにする。shutdownではMQTT受信を停止し、残りのbufferと処理中の保存を待ってから計測結果をJSONへ書き出す。

### apps/simulator

設定した台数の仮想ドローンからの接続状態とテレメトリ送信、コマンド受信を実装済みである。

- 約5秒ごとのテレメトリ送信
- 接続状態の通知
- バッテリー残量、位置、高度、温度の変化
- 自機宛てコマンドの受信とACKの送信
- RETURN_HOMEによる飛行状態の変更
- REBOOTによる正常切断と再接続後のONLINE通知

`DRONE_COUNT`で起動台数を指定し、既定値は10台とする。deviceIdは`DEVICE_ID_PREFIX`（既定値`drone`）と連番から割り当て、機体ごとに独立したMQTTクライアントを使用する。`MQTT_TRANSPORT=local`では従来どおりMosquittoへ接続する。`aws-iot`ではATS endpointとRoot CAを共通にし、deviceIdごとのクライアント証明書・秘密鍵を読み込んでThing名と同じclientIdでmTLS接続する。`SIMULATION_SEED`は既定値を`default`とし、1〜128文字を受け付ける。1000台規模の動作保証はPhase 1に含めない。

機体状態はテレメトリのsequenceを時間ステップとして決定論的に計算する。シードとdeviceIdから安定した32bit値を作り、機体ごとの位相、初期バッテリー、位置中心、温度差へ反映する。同じシード、deviceId、sequenceからは同じ状態を生成し、シードまたはdeviceIdが異なる場合は別の系列になる。メッセージ作成時刻は実時刻を使うため再現対象に含めない。バッテリーは1ステップにつき0.5ポイント減少して0で下げ止まり、緯度・経度、高度、温度は40ステップ周期で変化する。

### apps/load-generator

ローカル負荷検証用に、指定したdeviceId範囲を接続レートに従ってMosquittoへ接続し、一定間隔でテレメトリを送信する。通常のシミュレータとは分離し、接続状態やコマンド処理は持たない。複数プロセスや複数ホストではdeviceIdの開始位置と台数を分ける。

送信件数と実行時間の両方に上限を設け、先に達した方で新規送信を停止する。終了時は進行中の送信を待ち、timerとMQTT接続を閉じてJSONレポートを保存する。試験ID、セッションID、設定、開始・終了時刻、停止理由、送信カウンタ、機体ごとの最終sequenceはレポートに記録し、productionのテレメトリには負荷試験専用フィールドを追加しない。transportはローカルMQTTとAWS IoT Coreを切り替えられる。AWSモードはmTLSとBasic Ingestを使い、Billing確認フラグと月間200,000件の自主上限を起動前に検証する。上限外のwarmup publishを避けるためmeasurement windowはAWSモードで使用しない。load deviceは接続開始前に全台分の認証情報を確認し、deviceIdごとに別の証明書を読み、clientIdとThing nameをdeviceIdへ一致させる。検証topicの購読は専用probeに分離する。

### 負荷試験レポート集約

`apps/load-report`は同じtestIdのgeneratorレポートとingestorレポートを読み、PostgreSQLの実保存データと突き合わせる。generator sessionごとのdeviceId集合とdevice timestampの開始・終了範囲をDB検索条件に使い、送信成功数、実保存件数、欠損数、sequenceをsession別に保持する。同一deviceを使うsessionは時間範囲が重ならない場合だけ集約できる。これにより、プロセス再起動でsequenceが0へ戻る場合も別sessionとして扱う。

集約レポートはJSONで保存し、送信、MQTT受信、検証、DB保存、実保存、欠損率、OFFLINE遷移を記録する。ingestorの固定bucketを統合して、送信から受信までの遅延とMQTT受信からDB transaction完了までの時間をそれぞれp50、p95、p99で出力する。送信成功数と各段階の件数が一致しない場合はsession別の内訳を含むエラーで終了する。

### apps/dashboard

React、Vite、TanStack Query、React Routerによる画面基盤と機体一覧・詳細画面、コマンド操作・履歴表示を実装済みである。API接続先は`VITE_API_BASE_URL`で指定し、未設定、読み込み中、通信失敗を画面に表示する。ローカル開発で別originになるAPIは、`DASHBOARD_ORIGIN`と一致するダッシュボードだけにCORSレスポンスを返す。一覧、詳細、コマンド履歴は5秒ごとに更新する。一覧は総台数、オンライン・オフライン台数、各機体の接続状態と最新値を表示し、詳細は位置、高度、温度を含む最新テレメトリを単位付きで表示する。詳細画面から帰還または再起動コマンドを確認後に送信でき、再起動は通信断への明示的な同意を必要とする。送信中は操作を無効化し、結果を画面に表示する。コマンド履歴には種類、状態、作成時刻、ACK受信時刻を表示し、送信直後と5秒ごとに更新する。APIからデータを取得し、MQTTやDBには直接接続しない。

- 総台数とオンライン・オフラインの台数（実装済み）
- 各機体の接続状態、バッテリー残量、最終受信時刻（実装済み）
- 位置、高度、温度、飛行状態（実装済み）
- 帰還・再起動の操作（実装済み）
- コマンド履歴と受領状態（実装済み）

### packages/protocol

デバイスと基盤の間で共有する通信仕様を実装済みである。

- MQTTトピック
- メッセージの型
- Zodによる実行時検証
- プロトコルのバージョン

詳細は[通信仕様](protocol.md)に記載する。

### packages/database

DBスキーマ、接続処理、マイグレーションを配置し、APIとMQTT受信処理から利用する。

### packages/config

Phase 0でTypeScriptの共通設定を実装した。各workspaceは`@drone-fleet/config/tsconfig.base.json`を継承し、固有の設定は各workspaceで管理する。

### infra

`local`にはMosquittoのローカル設定を置く。ルートの`compose.yaml`はPostgreSQLとMosquittoのhealthcheck、DBマイグレーション、MQTT受信処理、API、仮想ドローン、ダッシュボードの起動順を管理する。通常はAPIとダッシュボードだけをlocalhostへ公開する。ホスト側の開発コマンドでPostgreSQLとMosquittoへ接続するときは`compose.dev.yaml`を併用する。停止時は依存関係と逆の順序でサービスを終了し、シミュレータと各サービスが接続を閉じてから基盤サービスを停止する。`terraform`にはPhase 2のThing、IoT Policy、証明書attachment、ATS endpoint outputを置く。作成から削除までの順序は[AWS IoT Core接続手順](aws/README.md)に記載する。

`scripts/test-telemetry-path.sh`は専用のComposeプロジェクトでPostgreSQL、Mosquitto、DBマイグレーション、MQTT受信処理、シミュレータ1台、APIを起動する。シミュレータが生成したテレメトリがAPIへ到達することに加え、固定テレメトリをMQTTへ送信してAPIのテレメトリ履歴で全項目が一致することを、それぞれ上限時間付きで待つ。失敗時は経路上のサービス状態とログを出力し、終了時はテスト用データとプロセスを削除する。

## Phase 1のデータの流れ

### テレメトリ

1. 仮想ドローンがMQTTでテレメトリを送信する。
2. MQTT受信処理がメッセージを検証する。
3. デバイス情報とテレメトリをDBへ保存する。
4. ダッシュボードがAPIを通じて取得する。

### コマンド

1. ダッシュボードからAPIへコマンドを送る。
2. APIがコマンドをDBに記録する。
3. APIが対象機体のMQTTトピックへ送信する。
4. 仮想ドローンが受信し、同じcommandIdのACKを返す。
5. MQTT受信処理がコマンドの状態を更新する。
6. ダッシュボードで受領状態を確認する。

ACKはコマンドの受領を示す。帰還や再起動の完了とは区別する。

DB保存とMQTT送信は単一のトランザクションにはならない。ACKが送信結果の更新より先に届いてもACKNOWLEDGEDを維持し、TIMED_OUT後に届いたACKはタイムアウト時刻を残したままACKNOWLEDGEDへ更新する。

## Phase 1で保存するデータ

Phase 1では、次の3テーブルを使用する。

| テーブル | 内容 |
|---|---|
| devices | デバイスID、モデル、ソフトウェアバージョン、接続状態、最終受信時刻、登録・更新時刻 |
| telemetry | デバイスID、v2のセッションID（v1はnull）、連番、デバイス計測時刻、サーバー受信時刻、バッテリー残量、位置、高度、温度、飛行状態 |
| commands | コマンドID、対象デバイス、種類、処理状態、作成・送信・ACK受信・タイムアウト時刻 |

接続状態は`devices.connection_status`、飛行状態は`telemetry.flight_status`として別に管理する。テレメトリのsequenceはプロセス再起動で0へ戻るため単独では一意制約に使わず、機体とsequence、および機体と受信時刻の複合インデックスを持つ。v2のsessionIdは保存するが、一意制約と重複排除は#112で追加する。コマンドは機体と作成時刻、状態と作成時刻のインデックスを持つ。

初めて受信したdeviceIdは`devices`の主キーとupsertを使って登録する。同じdeviceIdの同時受信でも1行だけを保持する。`last_received_at`と`updated_at`は既存値と受信時刻の大きい方を保存し、並行処理の完了順によって時刻が戻らないようにする。Phase 1のメッセージには機体情報がないため、`model`と`software_version`は初期値を`null`とする。

## Phase 1の接続状態の判定

接続時はONLINEを通知する。予期しない切断はMQTTのLWTでOFFLINEを通知する。

通知だけに依存せず、最終受信時刻からの経過時間も使って判定する。通常のONLINE通知またはテレメトリ受信でONLINE、OFFLINE通知または既定15秒の未受信でOFFLINEとする。閾値は`OFFLINE_TIMEOUT_MS`で変更できる。購読直後に届くretainedのONLINE通知だけでは現在も接続中とは確認できないため、未知deviceの登録だけを行い、接続状態と最終受信時刻は更新しない。防御的にretainedのテレメトリも同様に扱う。

## 設計の理由

### Phase 0ではサービスの境界から作る

Phase 1の機能を先回りせず、各アプリと共通パッケージの配置、TypeScriptの共通設定、ビルド経路だけを用意した。これにより、サービス間の責務を保ったままIssue単位で機能を追加できる。

### ComposeはMosquittoから始める

Phase 0ではMQTTブローカーの起動と送受信に範囲を絞った。`compose.yaml`へのPostgreSQLと各アプリの追加は、実装と起動条件が確定するPhase 1で行う。Mosquittoは`127.0.0.1:1883`にのみ公開し、匿名接続をローカル開発に限定する。

### MQTT受信とHTTP APIを分ける

デバイスからの受信処理と、画面からの要求処理では責務が異なる。分離することで、AWS接続の追加時に受信経路を変更しやすくする。

### 通信仕様を共有する

シミュレータと受信側で型や検証処理がずれることを防ぐため、通信仕様を共通パッケージで管理する。

### PostgreSQLから始める

デバイス、テレメトリ、コマンドの保存先を揃え、ローカルで再現できる構成にする。

### Fastifyを使う

HTTPの入出力と、DB操作やMQTT送信を分けて実装する。初期段階では大きなフレームワークや独自の抽象化を増やさない。

## AWSへの拡張

Phase 2でAWS IoT Coreへの接続を追加した。

- デバイスごとのIDと証明書
- mTLS接続
- IoT Policyによる権限制御
- telemetry-ingestorによるクラウド側の受信処理
- APIによるコマンド送信
- Terraformによる環境構築

```mermaid
flowchart LR
    Device["デバイス"]
    Broker["AWS IoT Core"]
    Ingestor["telemetry-ingestor"]
    API["API"]
    DB["PostgreSQL"]

    Device -->|"telemetry / status / ACK"| Broker
    Broker --> Ingestor
    Ingestor --> DB
    API -->|"command"| Broker
    Broker --> Device
    API --> DB
```

通常運用ではtelemetry-ingestorとAPIが別々のバックエンド証明書でAWS IoT Coreへ直接MQTT接続する。新しいCloud AdapterやIoT Ruleは通常経路へ追加しない。topic、payload、QoS、retain、検証、DB処理はローカルのMosquittoと共通にし、接続先、mTLS、clientId、再接続だけをtransport固有にする。デバイスはThing name、clientId、deviceIdを一致させ、機体ごとに異なる証明書と最小権限のIoT Policyを使う。

`test:aws-iot-e2e`は2台のtelemetry・status・command・ACK、他機体topicの拒否、無効証明書の接続拒否、ローカル経路の回帰を短時間で確認する。接続数、command数、待機時間を固定し、継続負荷は行わない。実行結果とAWSリソースの削除順序は`docs/aws/e2e.md`へ記録する。

telemetry-ingestorは`MQTT_TRANSPORT=local`で従来のMosquitto、`aws-iot`でATS endpointへ接続する。AWSモードではデバイスやAPIと共有しない証明書、固定clientId、telemetry・status・ACKだけを購読できるPolicyを使う。接続完了後の切断ではMQTT clientが再接続と再購読を行い、受信したmessageはtransportに関係なく既存のprotocol検証とDB保存へ渡す。

APIも`MQTT_TRANSPORT`でMosquittoとAWS IoT Coreを切り替える。AWSモードではデバイスやtelemetry-ingestorと共有しない証明書と固定clientIdを使い、commands topicへのpublishだけを許可する。コマンドはtransportに関係なくPENDING保存、QoS 1 publish、SENTまたはFAILED更新、ACK追跡の既存処理を通す。アプリケーションで別commandIdを作る再試行は行わず、接続後の切断ではmqtt.jsが同じQoS 1 publishを再送する。

Phase 2.5のBasic IngestとIoT Ruleは、短時間のテレメトリ負荷確認専用とし、通常運用の双方向経路とは分ける。接続経路、サービスの責務、認証情報の管理、採用しなかった案は[ADR 0004](adr/0004-aws-iot-connection-and-credentials.md)に記載する。

Phase 2のThing、デバイス・バックエンド用IoT Policy、証明書attachment、ATS endpointは`infra/terraform`で管理する。証明書と秘密鍵はTerraformで生成しない。plan、apply、output確認、destroyの手順は[Phase 2 AWS基盤のTerraform手順](aws/phase2-terraform.md)、一連の実行順序は[AWS IoT Core接続手順](aws/README.md)に記載する。

## 負荷検証

継続的な性能限界はローカル構成で測る。AWS IoT Coreでは、無料利用枠の範囲で証明書認証、接続レート、同時接続、クラウド経路を短時間確認する。

負荷生成器は、試験ID、セッションID、担当するdeviceIdの範囲、接続レート、送信間隔、最大送信件数、最大実行時間を指定できる構成とする。送信試行・成功・失敗を記録し、ingestorの受信・検証・保存結果と突き合わせる。

AWS向け実行では月間200,000件を自主上限とし、当月の使用済み件数を差し引いた残量を超える設定を拒否する。AWS Budgetsは通知に使い、停止は負荷生成器の件数と時間の上限で行う。無料利用枠の対象期間と残量を確認できない場合はAWS試験を実行しない。

計測条件、指標、合格条件、AWSで実行する短時間シナリオは[負荷検証の提案](proposals/load-testing.md)に記載する。

## 後続Phaseで扱うこと

- 通信断中のローカル保存と再送
- メッセージの重複排除
- 複数機体への一括操作
- OTAと段階的な配信
- ROS 2との接続
- 運用ログを使ったAIによる調査支援

実装順序と完了条件は[ロードマップ](roadmap.md)に記載する。

## 関連ADR

- [ADR 0001: pnpmでTypeScriptのモノレポを構成する](adr/0001-monorepo.md)
- [ADR 0002: デバイスとの通信にMQTTを使う](adr/0002-mqtt-protocol.md)
- [ADR 0003: 初期の保存先にPostgreSQLを使う](adr/0003-database.md)
- [ADR 0004: AWS IoT Coreへ既存サービスを直接MQTT接続する](adr/0004-aws-iot-connection-and-credentials.md)
