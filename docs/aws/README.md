# AWS IoT Core接続手順

v0.2.0では、ローカルのMosquitto構成を残したまま、AWS IoT Coreのmessage brokerを経由する双方向通信を選べる。ここでは2台の仮想ドローンで環境を作成し、telemetry・status・command・ACKと権限制御を確認して、作成したAWSリソースを削除するまでの順序を示す。

継続負荷や限界性能の測定はこの手順に含めない。AWS経路は短時間の機能確認に限定し、負荷検証は[Phase 2.5](../roadmap.md#phase-25負荷検証)として扱う。

## ローカル構成との使い分け

- AWSを使わず試す場合は、リポジトリルートの[ローカルデモ](../../README.md#ローカルデモ)を使う。AWS CLI、証明書、Terraformは不要である。
- AWS IoT Coreを確認する場合だけ、この文書に従って一時リソースと証明書を準備する。
- `MQTT_TRANSPORT=local`と`aws-iot`を同時に指定しない。transportを戻せば、同じprotocol・DB・APIをローカル構成で利用できる。

## 前提

- Node.js 22.13.0以上、pnpm 10以上、Docker Engine、Docker Compose v2
- OpenSSL
- AWS CLI v2とTerraform 1.13以上2.0未満
- AWS CLI profile。以下では`drone-fleet`を使う
- AWS projectのselected Region。確認できない場合はAWS Settingsの `View all projects > Overview > Additional Info > Region` または`~/.aws/config`を確認する
- selected RegionでAWS IoT Coreを利用できること

このリポジトリで作成・削除に必要な主なAWS権限は次のとおりである。人のアクセス権はAWSのmanaged IAM experienceで管理し、アプリ用IoT Policyとは分ける。

- `sts:GetCallerIdentity`
- `iot:DescribeEndpoint`
- Thingの作成・参照・更新・削除
- IoT PolicyとPolicy versionの作成・参照・更新・削除
- Policyと証明書、Thingと証明書のattach・detach・一覧
- CSRからの証明書発行、証明書の参照・状態変更・削除

Terraformで必要な個別actionは[Phase 2 AWS基盤のTerraform手順](phase2-terraform.md#実行前の確認)、証明書操作は[デバイス証明書の発行と失効](device-certificates.md#必要なaws権限)を正とする。

## 1. AWS projectと費用を確認する

作業前にAWS SettingsのBillingでplan、credit、spend limitを確認する。Free Tierの条件や対象サービスは変更されるため、固定の無料件数を前提にしない。

```bash
aws sts get-caller-identity \
  --profile drone-fleet \
  --region ap-southeast-2

aws freetier get-account-plan-state \
  --profile drone-fleet \
  --region us-east-1

aws freetier get-free-tier-usage \
  --profile drone-fleet \
  --region us-east-1
```

`get-free-tier-usage`にAWS IoT Coreがない場合も、無料対象とは断定できない。利用記録がまだない場合と、Free Tier offerがない場合を区別できないため、実行前に[AWS Free Tier](https://aws.amazon.com/free/)とAWS SettingsのBillingを確認する。AWS Budgetsやspend limitは補助策であり、E2E自身の接続数・message数・実行時間の上限を置き換えない。

## 2. ローカルの保存先を準備する

認証情報はすべてGit管理外の`secrets/aws-iot`へ置く。秘密鍵はこの端末で生成し、AWS、Terraform、ログ、Issue、PRへ送らない。

```bash
install -d -m 700 secrets/aws-iot
curl --fail --proto '=https' --tlsv1.2 \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem \
  --output secrets/aws-iot/AmazonRootCA1.pem
chmod 600 secrets/aws-iot/AmazonRootCA1.pem
git check-ignore --quiet --no-index secrets/aws-iot
```

Root CAの取得元と内容はAWS公式情報と照合する。認証情報の実値は`.env`へ貼らず、Git管理外ファイルへのパスだけを設定する。

## 3. TerraformでThingとPolicyを準備する

`infra/terraform/terraform.tfvars.example`をGit管理外の`terraform.tfvars`へコピーし、selected Region、環境名、2台のdeviceIdを設定する。初回は`device_certificate_arns = {}`、telemetry-ingestorとAPIのcertificate ARNは`null`にする。

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -out=phase2-bootstrap.tfplan
terraform show phase2-bootstrap.tfplan
terraform apply phase2-bootstrap.tfplan
```

bootstrap planにはThing 2件と、デバイス用・telemetry-ingestor用・API用IoT Policyの3件だけを含める。IoT Rule、Lambda、SQS、Kinesis、RDS、EC2、CloudWatch Logsは通常経路に作成しない。Thing作成後にデバイス証明書を発行する。

## 4. 証明書を発行する

デバイスはThing name、MQTT clientId、deviceIdを一致させ、機体ごとに証明書を分ける。

```bash
cd ../..
AWS_PROFILE=drone-fleet pnpm aws:iot:certificate issue \
  --device-id dev-drone-001 \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot \
  --root-ca secrets/aws-iot/AmazonRootCA1.pem

AWS_PROFILE=drone-fleet pnpm aws:iot:certificate issue \
  --device-id dev-drone-002 \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot \
  --root-ca secrets/aws-iot/AmazonRootCA1.pem
```

telemetry-ingestorとAPIにも、それぞれ別の秘密鍵と証明書を用意する。バックエンドをThingとして登録したり、デバイス証明書を流用したりしない。同じ管理スクリプトのservice用commandは、秘密鍵とCSRを一時directoryで生成し、AWSへCSRだけを送る。

```bash
AWS_PROFILE=drone-fleet pnpm aws:iot:certificate issue-service \
  --service telemetry-ingestor \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot \
  --root-ca secrets/aws-iot/AmazonRootCA1.pem

AWS_PROFILE=drone-fleet pnpm aws:iot:certificate issue-service \
  --service api \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot \
  --root-ca secrets/aws-iot/AmazonRootCA1.pem
```

スクリプトは既存directoryを上書きしない。AWS発行後の保存や最終検査に失敗した場合は、発行した証明書を`INACTIVE`にして削除し、一時directoryも削除する。AWS側のcleanupにも失敗した場合は両方のエラーを返し、対象certificate IDを標準出力へ露出しない。発行後は4つの証明書がすべて異なるARNで、各ファイルとmanifestがmode `600`であることを確認する。詳細な配置と接続設定は[telemetry-ingestor](telemetry-ingestor.md#認証情報)と[API](api.md#認証情報)を参照する。

証明書ARNを`terraform.tfvars`へ設定し、最終planを確認してapplyする。

```bash
cd infra/terraform
terraform plan -out=phase2.tfplan
terraform show phase2.tfplan
terraform apply phase2.tfplan
terraform output
cd ../..
```

2台構成ではThing 2件、IoT Policy 3件、certificate attachment 4件となる。秘密鍵や証明書本文はplan、state、outputに含めない。

## 5. AWS経路を確認する

ATS endpointはTerraform outputから取得する。値を文書、Issue、PRへ貼らない。

```bash
AWS_IOT_ENDPOINT="$(terraform -chdir=infra/terraform output -raw iot_ats_endpoint)"

AWS_PROFILE=drone-fleet \
AWS_REGION=ap-southeast-2 \
AWS_IOT_ENDPOINT="${AWS_IOT_ENDPOINT}" \
AWS_IOT_DEVICE_CREDENTIALS_DIR=secrets/aws-iot \
pnpm test:aws-iot-e2e
```

E2Eは次を短時間で確認する。

1. ローカルMosquittoのtelemetry経路が引き続き通る。
2. 異なる証明書の2台が接続し、詳細APIからONLINEと保存済みtelemetryを取得できる。
3. APIから各機体へcommandを送り、ACKNOWLEDGEDになる。
4. ある機体の証明書で他機体topicへpublish・subscribeできない。
5. `INACTIVE`にした証明書で再接続できない。

実行条件、合否判定、2026年10月5日の結果は[AWS IoT Core E2E](e2e.md)に記録している。

## 6. 証明書とAWS環境を削除する

E2E後はアプリの接続を停止してから、関連付けを外す。証明書がPolicyやThingへattachされたままでは削除できない。

```bash
AWS_PROFILE=drone-fleet pnpm aws:iot:certificate revoke \
  --device-id dev-drone-001 \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot

AWS_PROFILE=drone-fleet pnpm aws:iot:certificate revoke \
  --device-id dev-drone-002 \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot
```

telemetry-ingestorとAPIの証明書も管理スクリプトで削除する。スクリプトはmanifestのservice、Region、certificate ARNとIDの対応を検証してから、次の順で処理する。

1. `list-attached-policies`で対象を確認し、`detach-policy`する。
2. 証明書を`INACTIVE`へ変更する。
3. 証明書を削除する。
4. AWS操作がすべて成功してからローカルの証明書directoryを削除する。

```bash
AWS_PROFILE=drone-fleet pnpm aws:iot:certificate revoke-service \
  --service telemetry-ingestor \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot

AWS_PROFILE=drone-fleet pnpm aws:iot:certificate revoke-service \
  --service api \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot
```

AWS操作が途中で失敗した場合はローカルdirectoryを残すため、同じcommandを再実行できる。AWS側の証明書削除が成功した後にだけローカルdirectoryを削除する。

最後にTerraformのdestroy planがThing 2件とPolicy 3件だけであることを確認して適用する。

```bash
terraform -chdir=infra/terraform plan -destroy -out=phase2-destroy.tfplan
terraform -chdir=infra/terraform show phase2-destroy.tfplan
terraform -chdir=infra/terraform apply phase2-destroy.tfplan
terraform -chdir=infra/terraform state list
```

AWS IoT CoreのThing、証明書、Policyが0件で、`terraform state list`が空であることを確認する。共用projectで既存リソースがある場合は、全体件数ではなく今回作成した名前とIDが消えていることを確認する。Billingは反映に時間がかかるため、作業直後だけで追加料金なしと確定しない。

## 検証済みの範囲

- selected Region `ap-southeast-2`で2台のmTLS接続
- telemetry・status・command・ACKの双方向経路
- 機体単位のtopic制限と無効証明書の接続拒否
- ローカルMosquitto経路の回帰
- 作成したThing、証明書、Policyの削除

未確認または未実装の範囲は、実機、継続的なAWS負荷、最大接続性能、通信断中の永続バッファと再送、Fleet Provisioning、証明書の自動ローテーション、OTA、ROS 2連携である。

## 関連文書

- [ADR 0004: AWS IoT Coreへ既存サービスを直接MQTT接続する](../adr/0004-aws-iot-connection-and-credentials.md)
- [Phase 2 AWS基盤のTerraform手順](phase2-terraform.md)
- [デバイス証明書の発行と失効](device-certificates.md)
- [デバイス用IoT Policy](device-policy.md)
- [シミュレータ](simulator.md)
- [telemetry-ingestor](telemetry-ingestor.md)
- [API](api.md)
- [AWS IoT Core E2E](e2e.md)
