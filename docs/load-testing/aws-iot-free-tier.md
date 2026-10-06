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

実行レポートには各deviceの`connectionStartedAt`、`connectedAt`、`connectionDurationMs`と、全体の`connections`集計を記録する。`connections.effectiveRatePerSecond`は、最初の接続開始から最後の接続成立までに成立した接続数を秒単位の経過時間で割った実測値である。`LOAD_CONNECTION_RATE_PER_SECOND`はpacing上限であり、この実測値とは区別する。

送信先は`$aws/rules/<ruleName>/fleet/v1/devices/<deviceId>/telemetry`で、通常のproduction telemetry schemaは変更しない。再接続は行わず、最大件数または最大時間に達した時点で全接続を閉じる。

## 終了と記録

1. 負荷生成器が全接続を閉じたことをレポートで確認する。
2. `load_device_certificate_arns = {}`と`probe_certificate_arn = null`へ戻して`terraform apply`し、Terraformが所有するIoT Policy attachmentを解除する。
3. 各load deviceとprobeについて`pnpm aws:iot:certificate revoke --device-id <deviceId> ...`を実行する。証明書管理スクリプトがThing attachmentを解除し、AWS側の削除が成功するまでローカルdirectoryを残すため、失敗時は同じコマンドを再試行する。
4. `terraform destroy`を実行する。
5. IoT Rule、Thing、IoT Policy attachment、Thing attachment、certificate、IAM role、Budgetが残っていないことをAWS ConsoleまたはCLIで確認する。
6. Billingの使用量と料金を再確認する。反映に時間差がある場合は、確認日時と未反映である旨を記録し、反映後に追記する。
7. 実行条件と結果を次の表で記録する。

### 2026-10-06 最小構成の実行結果

selected Region `ap-southeast-2`で、load device 2台と専用probeを使って確認した。継続負荷や100台以上のシナリオは実行していない。

| 項目                       | 実行前                                        | 実行後                                        |
| -------------------------- | --------------------------------------------- | --------------------------------------------- |
| 確認日時                   | 2026-10-06 08:59 JST                          | 2026-10-06 09:14 JST                          |
| アカウントプラン・対象期間 | FREE / ACTIVE、2027-04-03まで                 | FREE / ACTIVE、2027-04-03まで                 |
| Free Tier / credit残量     | `$100`、`get-free-tier-usage`は0件            | `$100`、`get-free-tier-usage`は0件            |
| AWS IoT当月使用量          | service集計`571`（Unit `N/A`）                | service集計`571`（Unit `N/A`）                |
| AWS IoT料金                | `$0`（Cost Explorerの`Estimated: true`）      | `$0`（Cost Explorerの`Estimated: true`）      |
| cross-device publish拒否   | 未実行                                        | 接続切断による拒否を確認                      |
| 作成リソース               | Thing、Rule、Policy、certificateはいずれも0件 | Thing、Rule、Policy、certificateはいずれも0件 |

実行結果は次のとおり。

- probe 1件が`Basic Ingest -> IoT Rule -> verified topic`へ到達した。経路内遅延は666msだった。
- load device 2台を2接続/秒で接続し、最大4件で停止した。送信は4件成功、0件失敗だった。
- `load-000001`の証明書で`load-000002`のBasic Ingest telemetry topicへpublishすると、AWS IoT Coreが接続を切断した。
- Policy attachmentを解除し、3枚の証明書を失効・削除してからTerraformで8リソースをdestroyした。
- 削除後、Thing、certificate、Rule、Policyはすべて0件で、検証用IAM roleも存在しないことを確認した。

Cost Explorerの料金はまだ推定値であり、使用量の反映にも時間差がある。料金が確定するまでは追加料金なしの最終確認を完了扱いにしない。

### 2026-10-06 100台の実行結果

最小構成の確認後、同じselected Region `ap-southeast-2`で100台・5秒間隔・最大10分の短時間確認を実施した。AWS IoT Coreの限界性能を測る試験ではない。

| 項目                       | 実行前                                        | 実行後                                        |
| -------------------------- | --------------------------------------------- | --------------------------------------------- |
| 確認日時                   | 2026-10-06 09:30 JST                          | 2026-10-06 10:14 JST                          |
| アカウントプラン・対象期間 | FREE / ACTIVE、2027-04-03まで                 | FREE / ACTIVE、2027-04-03まで                 |
| Free Tier / credit残量     | `$100`、`get-free-tier-usage`は0件            | `$100`、`get-free-tier-usage`は0件            |
| AWS IoT当月使用量          | service集計`571`（Unit `N/A`）                | service集計`571`（Unit `N/A`）                |
| AWS IoT料金                | `$0`（Cost Explorerの`Estimated: true`）      | `$0`（Cost Explorerの`Estimated: true`）      |
| cross-device publish拒否   | 未実行                                        | 接続切断による拒否を確認                      |
| 作成リソース               | Thing、Rule、Policy、certificateはいずれも0件 | Thing、Rule、Policy、certificateはいずれも0件 |

実行条件と結果は次のとおり。

- 実行前に、100台・10分の接続1,000分、最大12,000件、RuleとAction各12,000件がAWS IoT Coreの月間Free Tier内であることを確認した。
- Cost Explorerのservice単位の`UsageQuantity: 571`は、UsageTypeとUnitが異なる利用量を合算した値である。message件数として扱わず、自主上限の計算には使用していない。
- project側で追跡できるpublishは、load generator最大12,000件、probe 1件、cross-device否定系1 attemptの最大12,002件である。月間200,000件の自主上限まで187,998件の余裕があった。実測は合計11,159件だった。
- 100台へ別々の証明書を発行し、MQTT clientIdをThing nameと一致させた。`LOAD_CONNECTION_RATE_PER_SECOND=25`をpacing上限として設定したが、接続開始・成立時刻を記録していないため実効接続レートは計測できていない。
- reportには100台すべてのdevice entryがあり、各deviceで1件以上のpublish成功を確認した。100台の接続成立とpublishは確認済みだが、実効接続レートの確認結果とは扱わない。
- probe 1件が`Basic Ingest -> IoT Rule -> verified topic`へ到達した。経路内遅延は715msだった。
- 100台を5秒間隔で10分実行し、11,157件成功、0件失敗だった。接続を直列に開始した影響で最大12,000件より先に10分へ達し、`MAX_DURATION`で停止した。
- `load-000001`の証明書で`load-000002`のBasic Ingest telemetry topicへpublishすると、AWS IoT Coreが接続を切断した。
- Policy attachment 101件を解除し、101枚の証明書を失効・削除してからTerraformで106リソースをdestroyした。
- 削除後、Thing、certificate、Rule、Policyはすべて0件で、検証用IAM roleも存在しないことを確認した。ローカルの秘密鍵、証明書、Terraform state、実行レポートも削除した。

実行直後のCost Explorerは`$0`だが、`Estimated: true`のままで使用量も未反映だった。料金確定後の確認は引き続き必要である。

### 2026-10-06 実効接続レートの再計測

実効接続レートを記録する変更をmainへ反映後、selected Region `ap-southeast-2`で100台を再計測した。`LOAD_CONNECTION_RATE_PER_SECOND=25`は接続開始のpacing上限であり、実測値ではない。

| 項目                     | 結果                                                        |
| ------------------------ | ----------------------------------------------------------- |
| 計測日時                 | 2026-10-06 15:40:48〜15:43:18 JST                           |
| 接続                     | 100台成功、0台失敗                                          |
| 接続確立時間             | 85.614秒                                                    |
| 実効接続レート           | 1.168接続/秒                                                |
| 1台ごとの接続所要時間    | 最小793ms、最大925ms、平均815.08ms                          |
| telemetry                | 2,183件成功、0件失敗、100台すべてで1件以上成功              |
| probe                    | 1件到達、経路内遅延672ms                                    |
| cross-device publish拒否 | `load-000001`から`load-000002`への送信を接続切断で拒否      |
| 実行後のリソース         | Thing、certificate、Rule、Policyはいずれも0件、IAM roleなし |
| Free Plan / credit残量   | FREE / ACTIVE、`$100`、2027-04-03まで                       |
| AWS IoT料金              | `$0`（Cost Explorerの`Estimated: true`）                    |

結果から、現行の負荷生成器は各TLS接続の完了を待って次の接続を開始しており、25接続/秒のpacing上限より接続処理時間が支配的であることが分かった。今回の目的は100台のクラウド経路確認であり、並列接続による性能改善はIssue #64の範囲に含めない。

最初の10分設定は実行環境の長時間セッション上限で終了レポートを保存できなかったため、計測結果として採用していない。続く60秒の予備計測では69台成功、0台失敗、実効1.165接続/秒を確認し、100台全件を確認できる150秒へ延長して上表の結果を得た。自主上限の管理では、レポートがない試行を最大12,000件として保守的に計上した。過去の実測11,159件、probe 1件、予備計測445件、最終計測2,183件、否定系1 attemptを合わせた追跡上限は25,789件で、月間200,000件の自主上限まで174,211件の余裕がある。

終了後はPolicy attachment 101件を解除し、101枚の証明書を失効・削除してからTerraformで106リソースをdestroyした。2026-10-06 16:00 JSTにAWS上の残存がないことを確認し、ローカルの秘密鍵、証明書、Terraform state、実行レポートも削除した。

Cost ExplorerはUsageType別に`APS2-ConnectionMinutes: 89 Minutes`、`APS2-Messages: 436 Messages`、`APS2-RegistryAndShadowOperations: 46 Operations`、料金`$0`だった。いずれも実行前と同じ値で`Estimated: true`のため、今回分は未反映である。料金確定後の確認は引き続き必要である。

100 / 1,000 / 10,000台では同数のThingと証明書が必要になる。接続・messageだけでなく、証明書発行数、API呼び出し数、削除時間も実行前に見積もる。いきなり大規模シナリオを実行せず、1台のprobeと最小台数で発行・拒否・削除を確認してから段階を上げる。

認証、100台すべての接続成立とpublish、実効接続レート、データ到達、cross-device拒否、リソース削除までは確認済みである。Cost Explorerの料金は未確定であるため、Issue #64はcloseしない。

## 公式資料

- [AWS IoT Core - Pricing](https://aws.amazon.com/iot-core/pricing/)
- [Reducing messaging costs with Basic Ingest](https://docs.aws.amazon.com/iot/latest/developerguide/iot-basic-ingest.html)
- [Using the Free Tier API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-free-tier-api.html)
- [Tracking your AWS Free Tier usage](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/tracking-free-tier-usage.html)
