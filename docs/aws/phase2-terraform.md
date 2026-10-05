# Phase 2 AWS基盤のTerraform手順

`infra/terraform`は、Phase 2の通常通信に必要なAWS IoT Coreの基盤を作成する。設計判断は[ADR 0004](../adr/0004-aws-iot-connection-and-credentials.md)を参照する。

## 作成するリソース

- `device_ids`ごとのAWS IoT Thing
- Thing policy variableで自機topicだけを許可するデバイス用IoT Policy
- デバイス証明書へのPolicy attachment
- telemetry-ingestor用IoT Policy
- telemetry-ingestor専用証明書へのPolicy attachment（certificate ARN設定時）
- API用IoT Policy

AWS IoT CoreのATS endpointはdata sourceで取得し、apply後のoutputへ出す。通常通信はmessage brokerを使うため、IoT Rule、Lambda、SQS、Kinesis、RDS、EC2、CloudWatch Logsは作成しない。デバイス証明書はTerraformの外で発行し、Thingへ関連付ける。発行・失効手順は[デバイス証明書の発行と失効](device-certificates.md)、topic権限と検証手順は[デバイス用IoT Policy](device-policy.md)を参照する。

サンプルの2台でtelemetry-ingestor専用certificate ARNを設定した場合、planに`aws_iot_thing`が2件、`aws_iot_policy`が3件、`aws_iot_policy_attachment`が3件だけ現れることを確認する。attachmentはデバイス証明書用が2件、telemetry-ingestor専用証明書用が1件となる。data sourceはリソース件数に含めない。

## 実行前の確認

1. Billing and Cost Managementで、現在のアカウントプラン、Free Tierまたはcreditの残量、対象期間を確認する。
2. 作業対象のAWS account IDとregionを確認する。
3. `terraform.tfvars.example`を`terraform.tfvars`へコピーし、環境名、region、deviceId、`#93`で発行したdevice certificate ARN、telemetry-ingestor専用certificate ARNを設定する。
4. deviceIdはThing nameとMQTT clientIdにも使う。別環境を同じaccount・regionへ作る場合は、`dev-drone-001`のように環境を含むdeviceIdを使う。
5. state、plan、`terraform.tfvars`がGitの追跡対象外であることを確認する。

必要なAWS権限は次のとおりである。

- `sts:GetCallerIdentity`
- `iot:DescribeEndpoint`
- `iot:CreateThing`、`iot:DescribeThing`、`iot:UpdateThing`、`iot:DeleteThing`
- `iot:CreatePolicy`、`iot:GetPolicy`、`iot:DeletePolicy`
- `iot:CreatePolicyVersion`、`iot:GetPolicyVersion`、`iot:ListPolicyVersions`、`iot:SetDefaultPolicyVersion`、`iot:DeletePolicyVersion`
- `iot:AttachPolicy`、`iot:DetachPolicy`、`iot:ListAttachedPolicies`

証明書の作成権限、IAM roleの作成権限、IoT Ruleや後段サービスの権限は#92のapplyには不要である。

## 静的検証

AWS認証情報を使わず、providerの構文とmock planを検証できる。

```bash
cd infra/terraform
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform test
```

`terraform test`はmock providerを使用し、2台のThing、ATS endpoint、バックエンドclientId、デバイスPolicyのclientId・topic制限、証明書へのattachmentを確認する。実AWSへ接続せず、リソースも作成しない。

## planとapply

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -out=phase2.tfplan
terraform show phase2.tfplan
terraform apply phase2.tfplan
terraform output
```

`terraform show`では、設定した台数分のThing、3件のIoT Policy、デバイス証明書ごとのPolicy attachment、telemetry-ingestor専用証明書へのPolicy attachment以外に作成対象がないことを確認してからapplyする。`terraform output`で次を確認する。

- `aws_account_id`と`aws_region`が作業対象と一致する。
- `iot_ats_endpoint`が`-ats.iot.<region>.amazonaws.com`形式である。
- `device_thing_names`が指定したdeviceIdと一致する。
- `device_policy.attachment_count`がdeviceId数と一致する。
- telemetry-ingestorとAPIのclientId、Policy名、Policy ARNを取得できる。
- `telemetry_ingestor.certificate_attached`が`true`である。

秘密鍵と証明書本文はTerraformへ渡さず、outputにも含めない。stateにはThing、Policy、account IDなどの実環境識別子が含まれるため、Gitへ追加しない。ローカルstateは所有者だけが読める権限で保管する。

## 削除

```bash
cd infra/terraform
terraform plan -destroy -out=phase2-destroy.tfplan
terraform show phase2-destroy.tfplan
terraform apply phase2-destroy.tfplan
terraform state list
```

destroy planに対象外のリソースが含まれないことを確認してから適用する。最後の`terraform state list`が空であることに加え、AWS IoT CoreのThingとPolicyが残っていないことをConsoleまたはAWS CLIで確認する。

後続Issueで証明書を関連付けた後は、証明書を`INACTIVE`にし、PolicyとThingから切り離してからPhase 2基盤を削除する。順序は#93の失効手順を正とする。

## 費用と未確認範囲

ThingとIoT Policyを定義しただけでは接続時間やMQTT messageは発生しない。後続Issueで接続した時点から、AWS IoT Coreの接続時間、publish・delivery、retained message、データ転送などを確認する。AWSの料金とFree Tier制度は変更されるため、固定の無料件数を前提にしない。

この文書の手順は、AWS認証情報がない環境では`fmt`、`validate`、mock planまでを検証対象とする。実際のplan、apply、output、destroy、Billingの前後比較を実施していない場合は、PRへ未確認範囲として明記する。
