# AWS IoTクラウド経路の短時間確認

Issue #64では、AWS IoT Coreで継続性能の限界を測らない。証明書認証、接続レート、同時接続、Basic IngestからIoT Ruleを通るデータ到達だけを、月間200,000件の自主上限内で短時間確認する。継続負荷は[ローカル段階負荷試験](2026-10-02-local.md)で扱う。

## 実行前の停止条件

次のいずれかに該当する場合はAWSへ接続しない。

- Billing and Cost Managementで、現在のアカウントプラン、Free Tierまたはcreditの残量、対象期間を確認できない。
- 当月のプロジェクト使用済み件数と今回の`LOAD_MAX_MESSAGES`の合計が200,000件を超える。
- CloudWatch、Lambda、SQS、Kinesis、RDS、EC2、データ転送など、今回使わないサービスが構成に含まれる。
- 試験後すぐにPolicy attachment解除、証明書失効、`terraform destroy`、残存リソース確認を実行できない。

AWSのFree Tier制度はアカウント作成日とプランで異なる。2025年7月15日以降に作成したアカウントはcreditとFree/Paid planを基準にし、それ以前のアカウントはBillingに表示される有効なオファーを基準にする。固定の無料件数を前提にせず、毎回Billingの表示を確認する。

## AWSリソース

`infra/aws-load-test`は次を作成する。

- Basic Ingestで呼び出すIoT Rule
- `verified/fleet/v1/devices/<deviceId>/telemetry`へrepublishするRule actionとIAM role
- load deviceごとのThingと、接続元Thingと同じdeviceIdのBasic Ingest telemetryだけを許可するIoT Policy
- `verified` topicのsubscribe/receiveを専用に担う`load-probe` ThingとIoT Policy
- 通知先を指定した場合だけ、AWS IoTの実課金を通知する月次Budget

証明書と秘密鍵はTerraformで作成しない。Phase 2と同じく1 device = 1 certificateとし、`deviceId = Thing name = MQTT clientId`を維持する。秘密鍵は`secrets/aws-iot/<deviceId>/`へ置き、Terraform stateには証明書ARNだけを保存する。probe証明書をload deviceと共有しない。Thingと証明書の`EXCLUSIVE_THING` attachmentは証明書管理スクリプト、IoT Policy attachmentはTerraformだけが管理する。

最初は証明書mapを空にしてThingとPolicyを作る。

```bash
cd infra/aws-load-test
terraform init
terraform plan \
  -var='load_device_ids=["load-000001"]' \
  -out=issue-64.tfplan
terraform apply issue-64.tfplan
```

次に既存の証明書管理コマンドで各Thingとprobeへ異なる証明書を発行する。各発行処理はCSR方式を使い、途中で失敗した証明書をAWS側から削除する。成功済みの証明書はdeviceId別の`manifest.json`で追跡でき、後述の失効処理を再試行できる。

```bash
pnpm aws:iot:certificate issue --device-id load-000001 \
  --output-dir secrets/aws-iot --root-ca secrets/aws-iot/AmazonRootCA1.pem \
  --region ap-northeast-1
pnpm aws:iot:certificate issue --device-id load-probe \
  --output-dir secrets/aws-iot --root-ca secrets/aws-iot/AmazonRootCA1.pem \
  --region ap-northeast-1
```

manifestのARNを`load_device_certificate_arns`と`probe_certificate_arn`へ設定して再度applyする。同じARNの使い回し、deviceIdの不足・過剰、別RegionのARNはTerraformが拒否する。

Budgetは停止装置ではない。通知も必要な場合だけ`-var='budget_notification_email=...'`を追加する。停止は負荷生成器の件数・時間上限で行う。

## 1件の経路確認

最初に1接続・1件で、mTLS認証と`Basic Ingest -> IoT Rule -> verified topic`への到達を確認する。

```bash
AWS_IOT_FREE_TIER_CONFIRMED=true \
pnpm probe:aws-iot
```

成功時は`load-results/aws-iot-path-probe.json`に接続先、Rule名、topic、送受信時刻、経路内遅延を保存する。秘密鍵と証明書の内容は保存しない。

続いて`load-000001`の証明書で`load-000002`のBasic Ingest topicへpublishし、AWS IoT Coreが接続を切断することを確認する。許可されるのは証明書をattachしたThingと同じdeviceIdのtopicだけであり、load deviceには`verified` topicのsubscribe権限を付けない。確認日時と拒否結果を末尾の記録表へ残す。

## 短時間シナリオ

`.env`へendpoint、Rule名、Root CA、deviceId別credential directory、probe専用証明書、当月使用済み件数を設定する。`AWS_IOT_FREE_TIER_CONFIRMED=true`は、実行直前にBillingを確認した場合だけ設定する。

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
- AWSモードでは`LOAD_MEASUREMENT_START_AT`を受け付けず、上限外のwarmup publishを行わない。
- ネットワーク接続を始める前に、Root CAと対象deviceId全件の`device.pem.crt`、`private.pem.key`を読み込めることを確認する。1件でも失敗した場合は0接続・0publishで終了する。
- deviceIdをそのままMQTT clientIdにしてmTLS接続する。

送信先は`$aws/rules/<ruleName>/fleet/v1/devices/<deviceId>/telemetry`で、通常のproduction telemetry schemaは変更しない。再接続は行わず、最大件数または最大時間に達した時点で全接続を閉じる。

## 終了と記録

1. 負荷生成器が全接続を閉じたことをレポートで確認する。
2. `load_device_certificate_arns = {}`と`probe_certificate_arn = null`へ戻して`terraform apply`し、Terraformが所有するIoT Policy attachmentを解除する。
3. 各load deviceとprobeについて`pnpm aws:iot:certificate revoke --device-id <deviceId> ...`を実行する。証明書管理スクリプトがThing attachmentを解除し、AWS側の削除が成功するまでローカルdirectoryを残すため、失敗時は同じコマンドを再試行する。
4. `terraform destroy`を実行する。
5. IoT Rule、Thing、IoT Policy attachment、Thing attachment、certificate、IAM role、Budgetが残っていないことをAWS ConsoleまたはCLIで確認する。
6. Billingの使用量と料金を再確認する。反映に時間差がある場合は、確認日時と未反映である旨を記録し、反映後に追記する。
7. 実行条件と結果を次の表で記録する。

| 項目                       | 実行前 | 実行後 |
| -------------------------- | ------ | ------ |
| 確認日時                   | 未実行 | 未実行 |
| アカウントプラン・対象期間 | 未実行 | 未実行 |
| Free Tier / credit残量     | 未実行 | 未実行 |
| AWS IoT当月使用量          | 未実行 | 未実行 |
| AWS IoT料金                | 未実行 | 未実行 |
| cross-device publish拒否   | 未実行 | 未実行 |
| 作成リソース               | なし   | 未実行 |

100 / 1,000 / 10,000台では同数のThingと証明書が必要になる。接続・messageだけでなく、証明書発行数、API呼び出し数、削除時間も実行前に見積もる。いきなり大規模シナリオを実行せず、1台のprobeと最小台数で発行・拒否・削除を確認してから段階を上げる。

この表を実測値へ更新するまでは、認証、接続、データ到達、cross-device拒否、リソース削除、追加料金なしを確認済みとは扱わない。実装PRをmergeしても、実AWS確認が終わるまでIssue #64はcloseしない。

## 公式資料

- [AWS IoT Core - Pricing](https://aws.amazon.com/iot-core/pricing/)
- [Reducing messaging costs with Basic Ingest](https://docs.aws.amazon.com/iot/latest/developerguide/iot-basic-ingest.html)
- [Using the Free Tier API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-free-tier-api.html)
- [Tracking your AWS Free Tier usage](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/tracking-free-tier-usage.html)
