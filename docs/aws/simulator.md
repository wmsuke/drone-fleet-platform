# AWS IoT Coreへシミュレータを接続する

シミュレータは`MQTT_TRANSPORT`でローカルMosquittoとAWS IoT Coreを切り替える。topic、payload、LWT、コマンド処理は共通で、AWSモードだけ接続先、clientId、mTLS認証情報を変更する。

## 設定

`#93`で発行した証明書を`secrets/aws-iot/{deviceId}/`へ配置し、Git管理外の`.env`を次のように設定する。

```dotenv
MQTT_TRANSPORT=aws-iot
AWS_IOT_ENDPOINT=example-ats.iot.ap-northeast-1.amazonaws.com
AWS_IOT_ROOT_CA_PATH=secrets/aws-iot/AmazonRootCA1.pem
AWS_IOT_DEVICE_CREDENTIALS_DIR=secrets/aws-iot
DEVICE_ID_PREFIX=dev-drone
DRONE_COUNT=2
TELEMETRY_INTERVAL_MS=5000
SIMULATION_SEED=aws-demo
```

この例では`dev-drone-001`と`dev-drone-002`を起動し、各directoryの`device.pem.crt`と`private.pem.key`を使う。deviceId、Thing名、MQTT clientId、証明書directory名は一致させる。endpointには`mqtts://`やpathを付けない。

ローカルへ戻す場合は`MQTT_TRANSPORT=local`へ変更する。`MQTT_HOST`と`MQTT_PORT`の既存設定が使われ、AWS用の設定や証明書は読み込まれない。

## 起動

リポジトリのルートで実行する。

```bash
pnpm --filter @drone-fleet/simulator build
node --env-file=.env apps/simulator/dist/index.js
```

起動時にRoot CA、各deviceの証明書、秘密鍵を読み込めない場合は、認証情報の内容や実際のファイルパスを出さず、対象deviceIdと不足した種類を表示して終了する。初回接続で証明書が拒否された場合も再試行を続けず、起動エラーとして終了する。AWSモードはTLSのサーバー証明書検証を無効化しない。接続完了後に通信が切れた場合は、MQTT clientの再接続を使う。

## 通信と終了処理

- 接続時に自機の`commands`を購読し、retain付き`ONLINE`と最初のtelemetryを送る。
- 予期しない切断では、自機の`status`へ設定したretain付きLWTが`OFFLINE / CONNECTION_LOST`を通知する。
- MQTT clientは切断後に再接続し、再購読、`ONLINE`、telemetry送信を再開する。
- `SIGINT`または`SIGTERM`ではretain付き`OFFLINE / SHUTDOWN`を送ってから正常切断する。
- コマンドは既存処理で実行し、自機の`command-acks`へACKを返す。

AWS IoT Policyは[デバイス用IoT Policy](device-policy.md)を参照する。秘密鍵、証明書本文、実際のファイルパスはログ、Issue、PR、CI artifactへ記録しない。

## 短時間の確認

無料利用枠の消費を抑えるため、2台、長いtelemetry間隔で短時間だけ起動する。次を確認したらシミュレータを正常終了する。

1. 2台がそれぞれの証明書とclientIdで同時接続する。
2. 両方がtelemetryと`ONLINE`をpublishする。
3. AWS IoT Coreから自機のcommandをpublishし、シミュレータが処理してACKをpublishする。
4. MQTT接続を一時的に失わせ、再接続後に`ONLINE`とtelemetryを再送する。
5. 正常終了時に`OFFLINE / SHUTDOWN`をpublishしてから切断する。
6. 別deviceの秘密鍵を組み合わせた不正な認証情報で接続できない。

LWTが実際に購読側へ配送される経路、telemetry-ingestorでの保存、APIからのcommand送信を含む全体確認は#96〜#98で行う。
