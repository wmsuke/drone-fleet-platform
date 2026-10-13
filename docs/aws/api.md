# APIをAWS IoT Coreへ接続する

APIは`MQTT_TRANSPORT`でローカルMosquittoとAWS IoT Coreを切り替える。AWS固有処理はmTLS接続までとし、command schema、topic生成、PENDING保存、QoS 1 publish、SENT / FAILED更新、ACK追跡はローカルと共通の処理を使う。

## 認証情報

APIにはデバイスやtelemetry-ingestorと共有しないX.509証明書を使う。秘密鍵はローカルで生成し、CSRからAWS IoT証明書を発行する。ファイルはGit管理外の`secrets/aws-iot/api/`へmode `600`で保存し、親directoryはmode `700`にする。

発行したcertificate ARNはGit管理外の`infra/terraform/terraform.tfvars`へ設定する。

発行と失効には`pnpm aws:iot:certificate issue-service --service api`と`revoke-service`を使う。一連の順序は[AWS IoT Core接続手順](README.md#4-証明書を発行する)を参照する。

```hcl
api_certificate_arn = "arn:aws:iot:ap-northeast-1:123456789012:cert/3333333333333333333333333333333333333333333333333333333333333333"
```

TerraformはAPI用IoT Policyだけを証明書へattachする。Policyは固定clientIdでの接続と`fleet/v1/devices/*/commands`へのpublishだけを許可し、subscribe、receive、他suffixへのpublishは許可しない。Terraformはdevice、telemetry-ingestor、APIのcertificate ARNが相互に異なることをplan時に検証する。

## 接続設定

Git管理外の`.env`へ次を設定する。

```dotenv
MQTT_TRANSPORT=aws-iot
AWS_IOT_ENDPOINT=example-ats.iot.ap-northeast-1.amazonaws.com
AWS_IOT_ROOT_CA_PATH=secrets/aws-iot/AmazonRootCA1.pem
AWS_IOT_API_CLIENT_ID=drone-fleet-dev-api
AWS_IOT_API_CERTIFICATE_PATH=secrets/aws-iot/api/device.pem.crt
AWS_IOT_API_PRIVATE_KEY_PATH=secrets/aws-iot/api/private.pem.key
```

endpointには`mqtts://`やpathを付けない。clientIdは`terraform output -json api`の`client_id`と一致させる。認証情報を読み込めない場合は、秘密値と実際のパスを出さず、失敗した認証情報の種類を示して起動を中止する。接続失敗はoutboxの再送対象とし、設定した上限内で再試行する。

ローカルへ戻す場合は`MQTT_TRANSPORT=local`にする。従来の`MQTT_HOST`と`MQTT_PORT`を使い、AWS用ファイルは読み込まない。

## publishと再接続

APIはcommandとoutboxを同じDB transactionで保存し、HTTP 202 / PENDINGで受付を返す。workerがcommands topicへQoS 1、retainなしでpublishし、PUBACKでSENTに更新する。ACKはtelemetry-ingestorが受信し、ACKNOWLEDGEDへ更新する。202は機体の受領・操作完了ではない。

Phase 3ではAPI停止後もoutboxを読み、期限内に同じcommandId・payloadを再送する。各試行の接続は時間制限付きで破棄し、自動再接続のpacketキューを持たせない。設定と停止境界は[コマンドの期限と永続化](../command-durability.md#api-outbox)を参照する。

## 短時間の確認

1. APIが専用証明書と固定clientIdでAWS IoT Coreへ接続する。
2. 登録済みdeviceへHTTP APIからcommandを送り、対象deviceのcommands topicだけへ配信される。
3. simulatorのACKがtelemetry-ingestorを経由してACKNOWLEDGEDへ反映される。
4. 無効化したAPI証明書などでpublish失敗を発生させ、成功応答にならず履歴がFAILEDになることを確認する。

確認後もPhase 2の後続Issueで使う証明書とPolicy attachmentは保持する。削除時はPolicyをdetachし、証明書を`INACTIVE`にしてから削除する。
