# AWS IoTデバイス証明書の発行と失効

デバイスごとに異なるX.509証明書を発行し、秘密鍵をGit、Terraform state、標準出力、ログへ残さないための手順を定める。接続経路と認証情報の方針は[ADR 0004](../adr/0004-aws-iot-connection-and-credentials.md)、Thingの作成は[Phase 2 AWS基盤のTerraform手順](phase2-terraform.md)を参照する。

## 前提

- #92のTerraformをapplyし、対象deviceIdと同名のThingが存在する。
- AWS CLIで対象accountとregionへ接続できる。
- OpenSSLを利用できる。
- Amazon Root CA 1を[AWS公式サイト](https://www.amazontrust.com/repository/AmazonRootCA1.pem)から取得済みである。
- 証明書の保存先がGit管理外である。

必要なAWS権限は次のとおりである。IoT Policyの作成・attachは[デバイス用IoT Policy](device-policy.md)の手順で行う。

- `iot:DescribeThing`
- `iot:ListThingPrincipals`
- `iot:CreateCertificateFromCsr`
- `iot:DescribeCertificate`
- `iot:UpdateCertificate`
- `iot:DeleteCertificate`
- `iot:AttachThingPrincipal`
- `iot:DetachThingPrincipal`
- `iot:ListAttachedPolicies`
- `iot:DetachPolicy`

## 保存場所

リポジトリのルートで次を実行する。

```bash
mkdir -p secrets/aws-iot
chmod 700 secrets/aws-iot
curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem \
  --output secrets/aws-iot/AmazonRootCA1.pem
chmod 600 secrets/aws-iot/AmazonRootCA1.pem
git check-ignore --quiet --no-index secrets/aws-iot
```

発行後は次の構成になる。

```text
secrets/aws-iot/
├── AmazonRootCA1.pem
├── dev-drone-001/
│   ├── device.pem.crt
│   ├── manifest.json
│   └── private.pem.key
└── dev-drone-002/
    ├── device.pem.crt
    ├── manifest.json
    └── private.pem.key
```

`secrets/aws-iot`とデバイス別directoryはmode `700`、Root CA、証明書、manifest、秘密鍵はmode `600`とする。symlink、別ユーザー所有、groupまたはothersが書き込めるファイルは受け付けない。

## 発行

スクリプトは秘密鍵とCSRをローカルで生成し、AWS IoT CoreへCSRだけを送る。Terraformは証明書を管理しないため、秘密鍵と証明書本文はTerraform stateへ入らない。

```bash
pnpm aws:iot:certificate -- issue \
  --device-id dev-drone-001 \
  --region ap-northeast-1 \
  --output-dir secrets/aws-iot \
  --root-ca secrets/aws-iot/AmazonRootCA1.pem

pnpm aws:iot:certificate -- issue \
  --device-id dev-drone-002 \
  --region ap-northeast-1 \
  --output-dir secrets/aws-iot \
  --root-ca secrets/aws-iot/AmazonRootCA1.pem
```

処理順序は次のとおりである。

1. deviceId、保存先、Root CA、Git ignore、所有者、permissionを確認する。
2. Thingが存在し、principalが未関連付けであることを確認する。
3. mode `700`の一時directoryでRSA 2048 bitの秘密鍵とCSRを作る。
4. `CreateCertificateFromCsr`で証明書を発行・有効化する。
5. 証明書をThingへ`EXCLUSIVE_THING`として関連付ける。
6. CSRを削除し、デバイス別directoryへ移動する。
7. 保存したファイルの所有者とpermissionを再検査する。

同じdeviceIdのdirectoryがある場合、またはThingにprincipalが1件でも関連付いている場合は、既存資産を変更せずに終了する。ローカルdirectoryを削除して再発行する操作は禁止する。先に下記の失効手順でAWS側とローカル側を揃える。

発行後の標準出力にはdeviceIdだけを表示する。秘密鍵、CSR、証明書本文、AWS CLIの生レスポンスは出力しない。発行後の処理に失敗した場合は、作成済み証明書を`INACTIVE`にして削除し、一時directoryも削除する。

## 配置と設定

`.env`にはファイル内容ではなくパスだけを設定する。

```dotenv
AWS_IOT_ENDPOINT=example-ats.iot.ap-northeast-1.amazonaws.com
AWS_IOT_ROOT_CA_PATH=secrets/aws-iot/AmazonRootCA1.pem
AWS_IOT_DEVICE_CERTIFICATE_PATH=secrets/aws-iot/dev-drone-001/device.pem.crt
AWS_IOT_DEVICE_PRIVATE_KEY_PATH=secrets/aws-iot/dev-drone-001/private.pem.key
```

endpointは`terraform -chdir=infra/terraform output -raw iot_ats_endpoint`で取得する。この設定例はダミーのendpointとdeviceIdを使う。証明書と秘密鍵の実値は`.env.example`、Issue、PR、CI artifactへ貼り付けない。

配置とpermissionだけを再確認する場合は次を実行する。

```bash
pnpm aws:iot:certificate -- verify \
  --device-id dev-drone-001 \
  --region ap-northeast-1 \
  --output-dir secrets/aws-iot \
  --root-ca secrets/aws-iot/AmazonRootCA1.pem
```

## 失効と削除

失効は証明書のmanifestを読み、次の順序で行う。

1. #94で関連付けたIoT Policyをすべてdetachする。
2. Thingから証明書をdetachする。
3. `ACTIVE`な証明書を`INACTIVE`にする。
4. AWS IoT Coreから証明書を削除する。
5. 全AWS操作の成功後にだけ、対象デバイスのローカルdirectoryを削除する。

```bash
pnpm aws:iot:certificate -- revoke \
  --device-id dev-drone-001 \
  --region ap-northeast-1 \
  --output-dir secrets/aws-iot
```

AWS操作が途中で失敗した場合はローカルのmanifestと秘密鍵を残す。原因を解消して同じコマンドを再実行する。スクリプトは現在のPolicy attachment、Thing principal、証明書statusを取得してから必要な操作だけを行う。

## 未確認範囲

単体テストでは、2台への異なる証明書発行、permission、ローカル・AWS側の重複検知、PolicyとThingのdetach、無効化、削除、発行失敗時のcleanup、manifestのdeviceId・region・証明書ARNとIDの不整合拒否を偽のAWS応答で確認する。

AWS認証情報がない環境では、実際の証明書発行・失効は確認できない。実AWSで確認していない場合は、PRへ未確認範囲として明記する。
