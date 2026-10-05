# telemetry-ingestorをAWS IoT Coreへ接続する

telemetry-ingestorは`MQTT_TRANSPORT`でローカルMosquittoとAWS IoT Coreを切り替える。AWS固有処理はmTLS接続までとし、topic・payload検証、telemetryのバッチ保存、status更新、ACK処理はローカルと共通の処理を使う。

## 認証情報

telemetry-ingestorにはデバイスやAPIと共有しないX.509証明書を使う。秘密鍵はローカルで生成し、CSRからAWS IoT証明書を発行する。ファイルはGit管理外の`secrets/aws-iot/telemetry-ingestor/`へmode `600`で保存し、親directoryはmode `700`にする。

発行したcertificate ARNはGit管理外の`infra/terraform/terraform.tfvars`へ設定する。

発行と失効には`pnpm aws:iot:certificate issue-service --service telemetry-ingestor`と`revoke-service`を使う。一連の順序は[AWS IoT Core接続手順](README.md#4-証明書を発行する)を参照する。

```hcl
telemetry_ingestor_certificate_arn = "arn:aws:iot:ap-northeast-1:123456789012:cert/2222222222222222222222222222222222222222222222222222222222222222"
```

Terraformは`telemetry-ingestor`用IoT Policyだけを証明書へattachする。デバイスPolicyとAPI Policyはattachしない。秘密鍵と証明書本文はTerraformへ渡さない。

## 接続設定

Git管理外の`.env`へ次を設定する。値はselected RegionのTerraform outputと、ローカルに保存した認証情報へ合わせる。

```dotenv
MQTT_TRANSPORT=aws-iot
AWS_IOT_ENDPOINT=example-ats.iot.ap-northeast-1.amazonaws.com
AWS_IOT_ROOT_CA_PATH=secrets/aws-iot/AmazonRootCA1.pem
AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID=drone-fleet-dev-telemetry-ingestor
AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH=secrets/aws-iot/telemetry-ingestor/device.pem.crt
AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH=secrets/aws-iot/telemetry-ingestor/private.pem.key
```

endpointには`mqtts://`やpathを付けない。clientIdは`terraform output -json telemetry_ingestor`の`client_id`と一致させる。認証情報を読み込めない場合は、秘密値と実際のパスを出さず、失敗した認証情報の種類を示して起動を中止する。初回接続が拒否された場合も再試行を続けず起動エラーにする。

ローカルへ戻す場合は`MQTT_TRANSPORT=local`にする。従来の`MQTT_HOST`と`MQTT_PORT`を使い、AWS用ファイルは読み込まない。

## 購読と再接続

接続後に次を購読する。

| topic filter                      | QoS | 処理                                     |
| --------------------------------- | --: | ---------------------------------------- |
| `fleet/v1/devices/+/telemetry`    |   0 | protocol検証後に既存のバッチ処理でDB保存 |
| `fleet/v1/devices/+/status`       |   1 | ONLINE / OFFLINEとretainを既存規則で反映 |
| `fleet/v1/devices/+/command-acks` |   1 | 対応するcommandをACKNOWLEDGEDへ更新      |

接続完了後に切断した場合は1秒間隔で再接続し、mqtt.jsの`resubscribe`で同じtopic filterを再購読する。clean sessionを使うため、切断中のmessageを後から受け取る保証はしない。再送されたstatusは時刻を比較して反映し、ACKは既存処理で重複を許容する。telemetryはsimulator再起動でsequenceが0へ戻る仕様のため、deviceIdとsequenceだけでは重複排除しない。

購読対象外のtopicはIoT Policyで配送されない。topicとpayloadのdeviceId不一致、不正なJSON、schema不一致は既存の`packages/protocol`による検証で保存せず、payload本文をログへ出さずに理由とtopicを記録する。

## 短時間の確認

AWS利用量を抑えるため、simulator 2台と長いtelemetry間隔で短時間だけ確認する。

1. telemetry-ingestorが専用証明書と固定clientIdで接続し、3つのtopic filterを購読する。
2. AWS接続中のsimulatorから送ったtelemetryが既存DBへ保存される。
3. retain付きONLINE、正常終了のOFFLINE、LWTのOFFLINEがdevice状態へ反映される。
4. 既存commandに対応するACKを送信し、履歴がACKNOWLEDGEDになる。
5. 接続を一時的に失わせ、再接続後のmessageが保存される。
6. 不正なtopicとpayloadが保存されず、検証理由が確認できる。

確認後もPhase 2の後続Issueで使う証明書とPolicy attachmentは保持する。削除時はPolicyをdetachし、証明書を`INACTIVE`にしてから削除する。
