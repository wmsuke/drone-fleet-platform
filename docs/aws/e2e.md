# AWS IoT Core E2E

Phase 2のAWS経路を2台の仮想ドローンで短時間確認する。継続負荷や性能限界は対象外とし、`#64`のローカル負荷検証と分ける。

## 前提

- selected Regionは`ap-southeast-2`とする。
- #92〜#97のTerraform、Thing、4枚の専用証明書、IoT Policy attachmentを準備済みとする。
- `secrets/aws-iot`にRoot CA、2台のdevice、telemetry-ingestor、APIの認証情報を配置する。
- AWS CLI profileは既定で`drone-fleet`を使う。
- Docker、Node.js、Corepack、curl、AWS CLIを利用できる。

実行前にAWS SettingsのBillingで無料プランまたはcredit残量を確認する。スクリプトもFree Tier APIを読み取るが、usageが0件の場合は「無料対象」ではなく「現在返される利用記録がない」ことだけを意味する。

## 実行

```bash
AWS_PROFILE=drone-fleet \
AWS_REGION=ap-southeast-2 \
AWS_IOT_ENDPOINT=example-ats.iot.ap-southeast-2.amazonaws.com \
AWS_IOT_DEVICE_CREDENTIALS_DIR=secrets/aws-iot \
pnpm test:aws-iot-e2e
```

スクリプトは次を順に行う。

1. AWSプラン、Free Tier usageの対象件数、Thing・証明書件数を読み取る。
2. `test:telemetry-path`でローカルMosquitto経路の回帰を確認する。
3. 一時PostgreSQLとAWS接続のsimulator 2台、telemetry-ingestor、APIを起動する。
4. 2台のONLINEとtelemetry保存をHTTP APIから確認する。
5. 各deviceへRETURN_HOMEを1件ずつ送り、ACKNOWLEDGEDを確認する。
6. `dev-drone-001`証明書による`dev-drone-002`のtelemetry topicへのpublishとcommands topicへのsubscribeが拒否されることを確認する。
7. `dev-drone-002`証明書を`INACTIVE`にし、新規接続が拒否されることを確認する。
8. AWS使用量とリソース件数を再確認し、ローカルプロセスと一時DBを削除する。

件数は2台、commandは各1件、telemetry間隔は5秒に固定する。異常系probeは10秒で打ち切る。秘密鍵、証明書本文、certificate ARN、account ID、payload本文は結果へ保存しない。

## AWSリソースの削除

E2E成功後は接続が停止していることを確認し、次の順序で削除する。

1. device証明書のPolicyをdetachする。
2. device証明書をThingからdetachする。
3. device証明書を`INACTIVE`にして削除する。
4. telemetry-ingestorとAPIの証明書からPolicyをdetachし、証明書を`INACTIVE`にして削除する。
5. Terraformのdestroy planがThingとPolicyだけを対象にしていることを確認してapplyする。
6. Terraform stateとAWS IoT CoreのThing、証明書、Policyが空であることを確認する。

device証明書は既存スクリプトで削除する。

```bash
AWS_PROFILE=drone-fleet pnpm aws:iot:certificate revoke \
  --device-id dev-drone-001 \
  --region ap-southeast-2 \
  --output-dir secrets/aws-iot
```

バックエンド証明書もmanifestのcertificate ARN / IDが対象service・regionと一致することを検証し、Policy detach、`INACTIVE`、証明書削除の全AWS操作が成功した後にだけローカルdirectoryを削除する。最後に[Terraform手順](phase2-terraform.md#削除)でThingとPolicyを削除する。

## 2026-10-05の実行結果

環境はAWS無料プラン、selected Regionは`ap-southeast-2`を使用した。

| 確認項目           | 結果                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| simulator          | 異なる証明書の2台が接続                                                               |
| telemetry / status | 2台とも詳細APIでONLINEとDB保存済みの最新telemetryを取得                               |
| command / ACK      | 2台へ各1件送信し、両方ACKNOWLEDGED                                                    |
| topic分離          | 他機体topicへのpublish / subscribeを拒否                                              |
| 無効証明書         | `INACTIVE`化後の新規接続を拒否                                                        |
| ローカル回帰       | `test:telemetry-path`成功                                                             |
| Free Tier usage    | 実行前後ともAPIの返却対象0件                                                          |
| 追加料金           | 請求データへの反映待ちのため即時確定は不可。無料プランのcredit残量表示は実行前100 USD |
| 後片付け           | 接続と一時DBを停止・削除。Thing 0、証明書0、Policy 0、Terraform state空を確認         |

実行中の未確認事項は、請求データの遅延反映後の確定金額だけである。継続負荷、最大接続数、最大message rateは確認していない。

レビュー修正後も同じ環境で再実行し、権限外操作はMQTTの`error`または`close`による明示的な拒否だけを成功とした。応答がないまま10秒を超えた場合はE2E失敗となる。再実行後もThing 0、証明書0、Policy 0、Terraform state空を確認した。
