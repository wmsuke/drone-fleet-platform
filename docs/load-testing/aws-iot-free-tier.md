# AWS IoTクラウド経路の短時間確認

Issue #64では、AWS IoT Coreで継続性能の限界を測らない。証明書認証、接続レート、同時接続、Basic IngestからIoT Ruleを通るデータ到達だけを、月間200,000件の自主上限内で短時間確認する。継続負荷は[ローカル段階負荷試験](2026-10-02-local.md)で扱う。

## 実行前の停止条件

次のいずれかに該当する場合はAWSへ接続しない。

- Billing and Cost Managementで、現在のアカウントプラン、Free Tierまたはcreditの残量、対象期間を確認できない。
- 当月のプロジェクト使用済み件数と今回の`LOAD_MAX_MESSAGES`の合計が200,000件を超える。
- CloudWatch、Lambda、SQS、Kinesis、RDS、EC2、データ転送など、今回使わないサービスが構成に含まれる。
- 試験後すぐに`terraform destroy`と残存リソース確認を実行できない。

AWSのFree Tier制度はアカウント作成日とプランで異なる。2025年7月15日以降に作成したアカウントはcreditとFree/Paid planを基準にし、それ以前のアカウントはBillingに表示される有効なオファーを基準にする。固定の無料件数を前提にせず、毎回Billingの表示を確認する。

## AWSリソース

`infra/aws-load-test`は次を作成する。

- Basic Ingestで呼び出すIoT Rule
- `verified/fleet/v1/devices/<deviceId>/telemetry`へrepublishするRule actionとIAM role
- `load-*`の接続、Basic Ingest publish、検証topicのsubscribe/receiveだけを許可するIoT Policy
- 通知先を指定した場合だけ、AWS IoTの実課金を通知する月次Budget

証明書と秘密鍵は作成しない。Phase 2で発行済みの証明書ARNを`certificate_arn`へ渡し、秘密鍵は`secrets/`などGit管理外の場所に置く。Terraform stateにも秘密鍵を含めない。

```bash
cd infra/aws-load-test
terraform init
terraform plan \
  -var='certificate_arn=arn:aws:iot:ap-northeast-1:123456789012:cert/example' \
  -out=issue-64.tfplan
terraform apply issue-64.tfplan
```

Budgetは停止装置ではない。通知も必要な場合だけ`-var='budget_notification_email=...'`を追加する。停止は負荷生成器の件数・時間上限で行う。

## 1件の経路確認

最初に1接続・1件で、mTLS認証と`Basic Ingest -> IoT Rule -> verified topic`への到達を確認する。

```bash
AWS_IOT_FREE_TIER_CONFIRMED=true \
pnpm probe:aws-iot
```

成功時は`load-results/aws-iot-path-probe.json`に接続先、Rule名、topic、送受信時刻、経路内遅延を保存する。秘密鍵と証明書の内容は保存しない。

## 短時間シナリオ

`.env`へendpoint、Rule名、証明書パス、当月使用済み件数を設定する。`AWS_IOT_FREE_TIER_CONFIRMED=true`は、実行直前にBillingを確認した場合だけ設定する。

```bash
LOAD_TRANSPORT=aws-iot \
LOAD_TEST_ID=aws-100 \
LOAD_SESSION_ID=worker-1 \
LOAD_DEVICE_START=1 \
LOAD_DEVICE_COUNT=100 \
LOAD_CONNECTION_RATE_PER_SECOND=25 \
LOAD_TELEMETRY_INTERVAL_MS=5000 \
LOAD_SIMULATION_SEED=issue-64 \
LOAD_MAX_MESSAGES=12000 \
LOAD_MAX_DURATION_MS=600000 \
AWS_IOT_FREE_TIER_CONFIRMED=true \
AWS_IOT_MONTH_TO_DATE_MESSAGES=0 \
pnpm load:aws
```

AWSモードでは、負荷生成器が次を起動前に検証する。

- Free Tier確認フラグが明示的に`true`である。
- `AWS_IOT_MONTH_TO_DATE_MESSAGES + LOAD_MAX_MESSAGES <= 200000`である。
- CA、証明書、秘密鍵の各パスがあり、mTLSで接続できる。

送信先は`$aws/rules/<ruleName>/fleet/v1/devices/<deviceId>/telemetry`で、通常のproduction telemetry schemaは変更しない。再接続は行わず、最大件数または最大時間に達した時点で全接続を閉じる。

## 終了と記録

1. 負荷生成器が全接続を閉じたことをレポートで確認する。
2. `terraform destroy`を実行する。
3. IoT Rule、IoT Policy attachment、IAM role、Budgetが残っていないことをAWS ConsoleまたはCLIで確認する。
4. Billingの使用量と料金を再確認する。反映に時間差がある場合は、確認日時と未反映である旨を記録し、反映後に追記する。
5. 実行条件と結果を次の表で記録する。

| 項目                       | 実行前 | 実行後 |
| -------------------------- | ------ | ------ |
| 確認日時                   | 未実行 | 未実行 |
| アカウントプラン・対象期間 | 未実行 | 未実行 |
| Free Tier / credit残量     | 未実行 | 未実行 |
| AWS IoT当月使用量          | 未実行 | 未実行 |
| AWS IoT料金                | 未実行 | 未実行 |
| 作成リソース               | なし   | 未実行 |

現在の開発環境にはAWS認証情報がないため、実アカウントでの確認は未実行である。この表を実測値へ更新するまでは、認証、接続、データ到達、リソース削除、追加料金なしを確認済みとは扱わない。

## 公式資料

- [AWS IoT Core - Pricing](https://aws.amazon.com/iot-core/pricing/)
- [Reducing messaging costs with Basic Ingest](https://docs.aws.amazon.com/iot/latest/developerguide/iot-basic-ingest.html)
- [Using the Free Tier API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-free-tier-api.html)
- [Tracking your AWS Free Tier usage](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/tracking-free-tier-usage.html)
