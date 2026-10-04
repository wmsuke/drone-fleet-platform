# デバイス用IoT Policy

各デバイス証明書には共通のIoT Policyをattachし、Thing policy variableで接続中のThing名をtopicへ埋め込む。Thing name、MQTT clientId、deviceIdは同じ値を使い、証明書はThingへ`EXCLUSIVE_THING`として関連付ける。設計判断は[ADR 0004](../adr/0004-aws-iot-connection-and-credentials.md)、topic仕様は[通信仕様](../protocol.md)を参照する。

## 許可する操作

| 操作                | 対象                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| connect             | clientIdが`${iot:Connection.Thing.ThingName}`と一致し、証明書がThingへattach済みの場合だけ |
| publish             | 自機の`telemetry`、`status`、`command-acks`                                                |
| retained publish    | 自機の`status`だけ                                                                         |
| subscribe / receive | 自機の`commands`だけ                                                                       |

Policyは`${iot:ClientId}`をtopicへ使わない。clientIdに`+`や`#`を指定して権限を広げられないよう、`iot:Connect`のresourceをThing名へ固定し、全statementへ`iot:Connection.Thing.IsAttached = true`を指定する。

telemetry-ingestor用PolicyとAPI用Policyは別リソースであり、デバイス証明書にはattachしない。デバイスPolicyには全機体を表すtopic wildcardやバックエンド用clientIdを含めない。

## Terraform設定

`#93`で発行した各証明書の`manifest.json`から、certificate ARNをGit管理外の`terraform.tfvars`へ設定する。秘密鍵と証明書本文はTerraformへ渡さない。

```hcl
environment = "dev"
aws_region = "ap-northeast-1"

device_ids = [
  "dev-drone-001",
  "dev-drone-002",
]

device_certificate_arns = {
  dev-drone-001 = "arn:aws:iot:ap-northeast-1:123456789012:cert/0000000000000000000000000000000000000000000000000000000000000000"
  dev-drone-002 = "arn:aws:iot:ap-northeast-1:123456789012:cert/1111111111111111111111111111111111111111111111111111111111111111"
}
```

`device_certificate_arns`のkeyは`device_ids`と完全に一致させる。値は設定したregionのAWS IoT certificate ARNだけを受け付ける。サンプル値を実環境では使わない。

必要な追加権限は次のとおりである。

- `iot:AttachPolicy`
- `iot:DetachPolicy`
- `iot:ListAttachedPolicies`

## 接続確認

検証にはAWS IoT CoreへMQTT over TLSで接続できるclientを使う。各コマンドで秘密鍵や証明書本文を標準出力へ出さない。

正常系では次を確認する。

1. `dev-drone-001`の証明書とclientIdで接続できる。
2. 自機の`telemetry`、retain付き`status`、`command-acks`へpublishできる。
3. 自機の`commands`をsubscribeし、AWS IoT Coreからpublishしたcommandを受信できる。
4. `dev-drone-002`も同じ操作を自機topicで実行できる。

異常系では`dev-drone-001`の証明書を使い、次が拒否されることを確認する。

1. clientIdを`dev-drone-002`へ変えて接続する。
2. `fleet/v1/devices/dev-drone-002/telemetry`へpublishする。
3. `fleet/v1/devices/dev-drone-002/commands`をsubscribeする。
4. `fleet/v1/devices/+/commands`をsubscribeする。

拒否確認では、接続失敗、publish時の切断、SUBACK failureのいずれかを成功扱いにしない。実行したdeviceId、topic、許可・拒否の結果だけを記録し、certificate ARN、証明書本文、秘密鍵は記録しない。

Policy更新はAWS IoT Core側で反映に時間がかかる場合がある。更新直後の拒否結果が不安定な場合は新しいMQTT接続で再確認する。
