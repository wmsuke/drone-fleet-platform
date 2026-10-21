# 更新配信物の登録とlocal配信

#166で署名付きmanifest v1の登録・参照、検証済みreleaseの保存、専用HTTP配信を追加した。[ADR 0007](adr/0007-ota-update-evaluation-and-recovery.md)のうち配信物管理だけが対象である。端末への適用、OTA MQTT、deployment、healthによる更新成功判定は未実装である。

## 責務と安全上の境界

- `packages/releases`はmanifest・署名・archive検証と署名用CLIを提供する。SemVer rangeの判定には`semver`を使う。
- 署名者がCLIでobjectを先に公開し、APIが同じ領域をread-onlyで検証する。APIはmetadataだけをDBへ登録する。HTTPサービスは同じobjectをGET/HEADで配信する。書き込み・削除APIはない。
- 登録リクエストにURLやfile pathを含めない。APIは外部HTTP/DNSへ接続せず、検証済みdigestの固定file名だけを読むため、登録入力によるSSRFやredirectは発生しない。HTTPサービスも完全一致のpath以外を404にする。
- `compose.releases.yaml`は明示したときだけ有効になる。HTTPはCompose内とホストloopbackでの検証専用。外部公開・実機運用は禁止で、認証・認可も未実装である。外部配信にはHTTPSと認可の設計が別途必要になる。
- 配信領域と公開鍵だけをread-only mountする。秘密鍵は署名端末だけに置き、API・artifact containerへmountしない。設定directoryとobjectにsymlinkを使わない。
- 端末downloadで必要なorigin allowlist、接続時DNS検証、redirect拒否、取得予算・再試行は#168で実装する。今回は端末HTTP clientを実装していない。

## 生成・起動

Node.js 22.13以上、pnpm、Docker Composeを使う。以下は使い捨てのlocal専用鍵であり、本番鍵にしない。`secrets/`はGit管理外である。

```sh
pnpm install --frozen-lockfile
pnpm release:tool keygen secrets/ota/signing secrets/ota/trust
pnpm release:tool pack docs/examples/release-manifest.json docs/examples/release-demo.mjs secrets/ota/signing/private.pem secrets/ota/objects secrets/ota/release.json
docker compose -f compose.yaml -f compose.releases.yaml up --build -d
curl --fail-with-body -H 'Content-Type: application/json' --data-binary @secrets/ota/release.json http://127.0.0.1:3000/releases
curl --fail http://127.0.0.1:3000/releases
```

`docs/examples/release-demo.mjs`は配信検証専用fixtureであり、更新可能なsimulatorではない。実bundleは外部依存をbundle済みの`app/main.mjs`として生成する。CLIはbundleを実行しない。例は`linux-arm64`、x64環境では設定のplatformを`linux-x64`にする。別内容を作る際はreleaseId（UUID）とversionを新しくする。`OTA_SIGNING_KEY_ID`で署名鍵のIDを指定でき、既定は`local-demo`。CLIは出力envelopeや鍵を上書きしない。

単体で起動する場合は`pnpm build`後、APIに`OTA_RELEASE_DIR`（object領域の絶対path）、`OTA_TRUST_STORE_PATH`（公開鍵JSONのpath）を両方設定する。未設定なら従来どおりrelease APIを登録しない。artifactサービスは`OTA_RELEASE_DIR`を設定して`node packages/releases/dist/server.js`で起動し、8080で待ち受ける。Composeのホストportは`OTA_ARTIFACT_PORT`、mount元は`OTA_LOCAL_OBJECTS_DIR`と`OTA_LOCAL_TRUST_DIR`で変更できる。配信領域を秘密鍵の親directoryにしない。

GET応答の`artifactPath`を、事前に決めた配信originに連結して取得する。例：`http://127.0.0.1:8080/objects/<digest>.tar.gz`。取得bytesのSHA-256はmanifestのdigestと一致する。配信サービス自身も読み出しごとにdigestを照合し、破損bytesを200で返さない。query、相対path、userinfo付きURLを登録する機能はない。

## manifest・署名・互換性

manifest設定の例は[release-manifest.json](examples/release-manifest.json)。CLIが圧縮済みarchiveの`digest`（SHA-256の小文字64桁）と`size`（bytes）を補う。envelopeは`manifest`、`keyId`、`algorithm: Ed25519`、base64の`signature`を持つ。署名対象はenvelope全体ではなくmanifestのRFC 8785 canonical JSON UTF-8 bytesである。

登録用envelope自体もcanonical JSONに限定する。keyはUTF-16順、余白・末尾改行なし。CLIの出力を`--data-binary`で送る。重複key、未知の項目/algorithm、別表記、未知/失効鍵、不正署名を拒否する。schemaの値はASCII識別子・SemVer/range・安全な整数・booleanに制限し、任意JSONの正規化APIとしては提供しない。

初期applicationは`simulator` / `edge-agent`、platformは`linux-arm64` / `linux-x64`、entrypointは`app/main.mjs`に固定する。登録時のbaseline能力はNode.js 22.13.0、OTA protocol / supervisor / state schema各1.0.0、health contract `ota-health-v1`。`nodeRange`は`>=22.13.0 <23`の部分集合でbaselineを含むこと、他rangeは各baselineを含むことを検証する。端末ごとの実能力や現在version、rollback可能性は後続で照合する。`rollbackCompatible: true`だけでrollbackを許可しない。

archiveはPOSIX ustarの狭いsubsetを採用する。圧縮32 MiB、展開tar全体128 MiB、512 entry、深さ8まで。directoryと`app/`配下の`.mjs` / `.json` regular fileのみを許可し、空でない`app/main.mjs`を必須とする。絶対path、`..`、空のpath要素、重複、symlink/hardlink、device/FIFO、PAX/GNU拡張、setuid等を拒否する。gzipをstreamingで読み、上限到達で中止する。登録時に展開や実行はしない。

署名は配信元とbytesの一致を確認するものであり、JavaScriptの安全性・外部importなし・実行時の副作用を証明しない。bundleの作成・内容レビューは署名者の責務である。署名者やホスト管理者の侵害に対するsandboxではない。

## APIと永続性

| API | 応答・意味 |
| --- | --- |
| `POST /releases` | canonical envelopeを検証して201。同じID・同じenvelopeの再登録は200。双方とも端末への適用成功ではない |
| `GET /releases` | 新しい登録順に最大100件、`items` / `limit`を返す |
| `GET /releases/:releaseId` | 不変envelope、digest、登録/検証時刻`verifiedAt`、`verification: VERIFIED`、actor、固定`artifactPath`を返す |
| artifact `GET/HEAD /objects/:digest.tar.gz` | 配信物bytes。更新・削除・任意pathは受け付けない |

入力不正・署名・互換・size/digest不正は400、配信物未配置/読み出し不可は422、同じreleaseIdまたは`(application, version, platform)`への別内容登録は409、未登録IDは404、設定/DB不調・同時検証上限は503。同時検証/配信は各processで2件に制限する。

同時登録はDBの一意制約で直列化し、差し替えを拒否する。migration `0012_legal_swordsman.sql`がrelease tableとUPDATE/DELETE/TRUNCATE拒否triggerを追加する。参照有無にかかわらずreleaseを保持するため、参照中も変更・削除できない。deployment tableはまだ作らず、#169でreleaseIdへの`ON DELETE RESTRICT`参照を追加する。DB管理者によるtrigger無効化やhost上のobject改変までは防げない。

成功audit `release.registered`とreleaseは同じtransactionで保存する。HTTP操作者は`anonymous` / actorId nullで、登録時刻・検証結果`VERIFIED`とrequestIdを記録する。拒否/失敗も既存audit hookで理由コード・statusのみを記録し、URL、本文、鍵は残さない。拒否auditの保存失敗時の非必達などは[既存auditの境界](audit-log.md)に従う。

`VERIFIED`は登録時の検証記録であり、後日の鍵失効・object欠損がない保証ではない。trust storeは登録ごとに読み直す。鍵を失効するには公開鍵JSONの`revoked`をtrueにしてread-only設定を更新し、運用記録を残す。既存DB記録を改変せず、後続の端末適用前にも最新trust storeで再検証する。

object公開とDBは分散transactionにしない。CLIによるobjectの原子的公開・fsync後に登録する。登録失敗では未参照objectが残るが、検証済みreleaseを欠損させる自動削除は行わない。自動GC・server全体のquotaは未実装で、容量の監視・配置元backupは運用者が行う。機体ごと512 MiBの領域制限は端末側#168の対象である。CLI以外のwriterを許可しない。

停止は`docker compose -f compose.yaml -f compose.releases.yaml down`。既存DB/volumeや署名鍵・objectを自動で削除しない。使い捨て検証環境を削除する際も、他のreleaseから参照されるobjectや必要な鍵を消さない。migrationには自動downgradeを用意しない。

## 検証

```sh
pnpm check
pnpm exec vitest run packages/releases/test/releases.test.ts
# 使い捨てPostgreSQLへPOSTGRES_*を設定する。releaseはtest終了時も削除しない。
DATABASE_INTEGRATION=true pnpm api:test:integration
```

署名・失効・digest・size・互換条件・危険archive・HTTP固定path・並行登録・不変制約・audit失敗時rollbackを検証する。実更新・実機安全・AWS経路はこの検証に含めない。

参照：[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)、[Node.js crypto](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature)。
