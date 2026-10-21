# OTA通信仕様 v1

#167で`packages/protocol`へOTA要求・報告・DB保存receiptの型と実行時検証を追加した。[ADR 0007](adr/0007-ota-update-evaluation-and-recovery.md)に従う。simulatorの実適用・supervisor、OTAのpublish/subscribe、ingestor保存・評価workerはまだ未実装で、通常起動時にOTAを送信しない。

## topicと互換性

prefixは`fleet/v1/devices/{deviceId}/`。deviceIdは既存と同じ英数字・`_`・`-`、1〜64文字である。local/AWSとも以下の同じ契約を使う。

| suffix | 方向 | payload | QoS | retain |
| --- | --- | --- | --- | --- |
| `ota-requests` | API → supervisor | APPLY_RELEASE / STOP_UPDATE / QUERY_STATE | 1 | false |
| `ota-events` | supervisor → ingestor | PROGRESS / VERSION / HEALTH / STATE | 1 | false |
| `ota-receipts` | ingestor → supervisor | DB commit済みeventのSTORED | 1 | false |

topic生成は`createOtaRequestsTopic` / `createOtaEventsTopic` / `createOtaReceiptsTopic`、解析は既存の`parseMqttTopic`を使う。`parseOtaMessage(topic, decodedJson, packet)`はtopic種別・本文のdeviceId・QoS 1・retainなしを照合する。payloadは各Zod schemaで検証し、未知の項目はstripせず拒否する。URL・鍵・任意コマンド・自己申告actorを受け取らない。MQTT送信用`otaMqttOptions`も公開する。

旧command v1/v2、ACK v1/v2/v3、telemetry v1/v2、status/receipt v1の型・topic・既存の未知項目の扱いは変更しない。OTAを既存commandやACKのSUCCEEDEDへ混ぜず、OTA schemaVersionは独立した1とする。

## 共通の識別と時刻

要求・event・receiptは`deploymentId`、`stageId`、`targetId`、`attemptId`、`fence`、`release`を必須にする。IDは小文字UUID、fenceは1〜9223372036854775807の正規10進文字列とし、JS numberへ変換しない。`release`は不変manifestの`releaseId`、`digest`（圧縮archiveのSHA-256、小文字64桁）、`version`（正規SemVer、64文字まで）、`buildId`を持つ。登録済みmanifestとの照合が別途必要で、通信schemaだけで署名済みとは扱わない。

UTC時刻はすべて`YYYY-MM-DDTHH:mm:ss.sssZ`に固定する。requestの`createdAt`・`expiresAt`・`resultDeadline`はAPIの時刻、eventの`timestamp`・healthの`measuredAt`は端末の時刻である。端末はeventへ`receivedAt`を含めない。backendは受信時に`receivedOtaEventSchema`の`{ event, receivedAt }`としてサーバー受信時刻を別に付ける。時計ずれがあり得るため、端末timestampがreceivedAtより後というだけでschema不正にしない。

## 要求

`otaRequestMessageSchema` / `OtaRequestMessage`を使う。全要求に新規`commandId`、`createdAt`、`expiresAt`、`resultDeadline`、`evaluationVersion: ota-health-v1`を持たせる。

| type | 追加項目 | createdAtからのexpiresAt / resultDeadline |
| --- | --- | --- |
| APPLY_RELEASE | `purpose: APPLY / ROLLBACK` | 300秒 / 600秒 |
| STOP_UPDATE | 元APPLYの`applyCommandId` | 30秒 / 60秒 |
| QUERY_STATE | `applyCommandId`、`challengeId`（通常照会はnull、health照会はUUID） | 15秒 / 15秒 |

stop/queryは新しいcommandIdを持ち、対象attempt/fenceは変えない。QUERY_STATEのresultDeadlineは照会期限と同じで、元APPLYの結果期限を延長しない。未解禁stageのHELDはサーバー内部状態であり、期限が未確定の要求を送らない。schemaは固定の期限差を検証し、実行側はさらに`now < expiresAt`を確認する。期限ちょうどは開始不可とする。開始済み処理をexpiresAtだけで取り消さない。

APPLY例：

```json
{
  "schemaVersion": 1,
  "deviceId": "drone-001",
  "deploymentId": "90c85252-a66e-4f6d-8d4b-137a4a1b2e35",
  "stageId": "4f832c11-7133-40af-8b8b-b44093b012c6",
  "targetId": "c364ec3a-6865-442e-bf8d-13f0a1e22dd4",
  "attemptId": "532706c0-329d-472c-8a9c-fbf8072bce2c",
  "fence": "1",
  "release": {
    "releaseId": "67601555-a7e5-45f8-a2ab-3f61619c27d9",
    "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "version": "0.1.0",
    "buildId": "local-demo-1"
  },
  "commandId": "087032d9-0206-46f9-8a9f-64675a153735",
  "type": "APPLY_RELEASE",
  "purpose": "APPLY",
  "createdAt": "2026-10-21T00:00:00.000Z",
  "expiresAt": "2026-10-21T00:05:00.000Z",
  "resultDeadline": "2026-10-21T00:10:00.000Z",
  "evaluationVersion": "ota-health-v1"
}
```

## 報告

`otaEventMessageSchema` / `OtaEventMessage`を使う。すべてのeventは`eventId`、attempt内で永続的に単調増加する`sequence`（0以上の安全な整数）、`applyCommandId`、`supervisorBootId`、端末`timestamp`を持つ。同一eventの再送ではこれらを変えない。supervisor再起動後もsequenceはリセットせず、journalから継続する。`supervisorBootId`はsupervisor起動の識別で、更新対象の子の`bootId`とは別である。

| type | 内容 |
| --- | --- |
| PROGRESS | `requestType: APPLY_RELEASE / STOP_UPDATE`、`state`、原因の`commandId`、attempt内の再取得分も含む`downloadedBytes`、`reason` |
| VERSION | `running: { release, bootId }`。子から実際に採取した版・build・archive digestを報告する |
| HEALTH | `running`、`queryCommandId`、一回限りの`challengeId`、`measuredAt`、`sampleMonotonicMs`、`sampleAgeMs`、固定7項目の`checks` |
| STATE | `queryCommandId`、現在の`state`、観測した`running`（不明・未起動ならnull）。状態照会の事実であり再適用許可ではない |

PROGRESSのstateはRECEIVED → DOWNLOADING → VERIFIED → QUIESCING → SWITCHING → BOOTING → HEALTH_CHECKING → APPLIED、またはFAILED / STOPPED / UNCERTAIN。FAILED / UNCERTAINは定義済み理由コードを必須にし、通常進捗ではreasonをnullにする。自由文やstack traceを送らない。requestTypeがAPPLY_RELEASEならcommandIdをAPPLYのIDに一致させ、STOPPEDを許可しない。STOP_UPDATEなら別のcommandIdとRECEIVED / STOPPED / FAILED / UNCERTAINだけを許可する。stopのRECEIVEDを停止確認へ読み替えず、停止可能地点・子の状態を確認してからSTOPPEDを報告する。

HEALTHのchecksはeventLoop / telemetry / sqlite / commandReady / mqtt / subscriptions / receiptsの各PASSEDまたはFAILED。FAILEDを含むhealthも事実として受理し、成功値へ丸めない。sampleMonotonicMsはsupervisorの単調時計で採取したms、sampleAgeMsは送信内容確定までの採取経過msで、0〜5000。measuredAtからtimestampまでも0〜5000 msに制限する。再送では新しいtimestampやchallengeへ差し替えない。

VERSION/HEALTHのrunningは候補releaseと別フィールドにする。`otaEventContextError(event, apply)`はdevice/target/attempt/fence/APPLY ID等の不変scopeと候補releaseを照合し、VERSION/HEALTHでは実行中releaseの全項目も照合する。不一致はATTEMPT_MISMATCH / RELEASE_MISMATCHとして扱い、現在状態を進めない。STATEのrunningは旧版・不明であり得るため、候補と異なるだけではschema不正にしない。未報告を推測で補完しない。

health例（識別子はAPPLY例と対応する）：

```json
{
  "schemaVersion": 1,
  "deviceId": "drone-001",
  "deploymentId": "90c85252-a66e-4f6d-8d4b-137a4a1b2e35",
  "stageId": "4f832c11-7133-40af-8b8b-b44093b012c6",
  "targetId": "c364ec3a-6865-442e-bf8d-13f0a1e22dd4",
  "attemptId": "532706c0-329d-472c-8a9c-fbf8072bce2c",
  "fence": "1",
  "release": {
    "releaseId": "67601555-a7e5-45f8-a2ab-3f61619c27d9",
    "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "version": "0.1.0",
    "buildId": "local-demo-1"
  },
  "eventId": "4e08c9ee-b11b-49b2-b8fe-40fc82b149f2",
  "sequence": 8,
  "applyCommandId": "087032d9-0206-46f9-8a9f-64675a153735",
  "supervisorBootId": "055fb920-9191-473e-905d-642a046f993a",
  "timestamp": "2026-10-21T00:00:30.000Z",
  "type": "HEALTH",
  "running": {
    "release": {
      "releaseId": "67601555-a7e5-45f8-a2ab-3f61619c27d9",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "version": "0.1.0",
      "buildId": "local-demo-1"
    },
    "bootId": "7283e624-ee9d-43c9-bb89-56b5f4935db0"
  },
  "queryCommandId": "b7fbd516-28f8-4d0d-8994-9c1e6b4cf9cf",
  "challengeId": "d1ca2b70-344d-44c6-bd40-b752f27ab649",
  "measuredAt": "2026-10-21T00:00:29.500Z",
  "sampleMonotonicMs": 29500,
  "sampleAgeMs": 500,
  "checks": {
    "eventLoop": "PASSED",
    "telemetry": "PASSED",
    "sqlite": "PASSED",
    "commandReady": "PASSED",
    "mqtt": "PASSED",
    "subscriptions": "PASSED",
    "receipts": "PASSED"
  }
}
```

APPLIED、VERSION一致、単発healthの全PASSEDのどれも更新成功ではない。署名・実切替・新boot・60秒/13標本の新鮮な継続health・期限内DB保存を#170の評価で確認する。

## 重複・順序逆転・矛盾と保存receipt

以下は保存/評価側の契約である。#167はschemaと不変scope照合までで、DBの重複排除・状態遷移・challenge消費は#170で実装する。

| 入力 | 保存/評価側で行うこと |
| --- | --- |
| 同eventId・同payloadHash | 正本は1件、元と同じ保存receiptを再送する。受信し直した時刻でhealthを新鮮にしない |
| 同eventId・別payloadHash、同attempt/sequence・別event | conflict履歴を保存し、正本を変えない。異なる本文に成功receiptを返さない |
| sequenceの欠番・逆転 | 到着順で巻き戻さず履歴と採否理由を残す。欠番を成功の根拠として補完しない |
| 不明attempt・別scope・古いfence | 理由付き履歴に残し現在状態を進めない。schemaが通るだけで認可済みにしない |
| 別version/digest/build・矛盾した終端 | 元の事実を上書きせず照合待ち。後着の不良証拠で過去の成功を削除しない |
| 別bootのhealth、未登録/使用済みchallenge、別QUERYのID | 継続成功へ加えない。QUERYとattempt・APPLY・fence・bootを照合し一回限りにする |
| QUERY期限/結果期限後のevent | lateとして保存。`receivedAt < resultDeadline`の証拠だけで期限内成功を判定する |

`serializeOtaEvent`でschema検証後のeventを全階層key順に直列化し、そのUTF-8 bytesのSHA-256小文字hexをpayloadHashとする。受信時刻・DB metadataは含めない。JSONのkey順/余白ではhashを変えず、timestamp・sequence・進捗・healthの内容を変えれば別hashになる。入力はdecoded JSON objectで、サイズ制限/JSON decodeと採否履歴はconsumer側の責務である。

`otaReceiptMessageSchema` / `OtaReceiptMessage`は共通scope、eventId、payloadHash、`status: STORED`、サーバーのreceivedAt・storedAtを持ち、storedAt >= receivedAtを検証する。receiptはDB commit後だけ送る。保存済みでも評価に不採用の事実はSTOREDにできるが、現在状態の更新や適用成功は意味しない。端末はscope/eventId/hashの完全一致後に独立SQLite outboxを削除する。PUBACKでは削除しない。署名不正等のpayloadをreceiptで正当化しない。

receipt例（hashは説明用ダミーであり、上記healthの計算結果ではない）：

```json
{
  "schemaVersion": 1,
  "deviceId": "drone-001",
  "deploymentId": "90c85252-a66e-4f6d-8d4b-137a4a1b2e35",
  "stageId": "4f832c11-7133-40af-8b8b-b44093b012c6",
  "targetId": "c364ec3a-6865-442e-bf8d-13f0a1e22dd4",
  "attemptId": "532706c0-329d-472c-8a9c-fbf8072bce2c",
  "fence": "1",
  "release": {
    "releaseId": "67601555-a7e5-45f8-a2ab-3f61619c27d9",
    "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "version": "0.1.0",
    "buildId": "local-demo-1"
  },
  "eventId": "4e08c9ee-b11b-49b2-b8fe-40fc82b149f2",
  "payloadHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "status": "STORED",
  "receivedAt": "2026-10-21T00:00:30.100Z",
  "storedAt": "2026-10-21T00:00:30.200Z"
}
```

## IoT Policyと更新順

`infra/terraform/iot.tf`には既存statementを残し、以下のOTA権限だけを別statementで追加する。

- device：attached Thing名と一致する自機ota-eventsのPublish、自機ota-requests/ota-receiptsのSubscribe・Receiveのみ。
- API：ota-requestsのPublishのみ。events/receiptsの偽装や購読は許可しない。
- ingestor：機体別ota-eventsのSubscribe・Receive、ota-receiptsのPublishのみ。requestsは送れない。
- OTAへのRetainPublish、Jobs、Shadow、S3等のartifact取得権限は追加しない。既存statusだけのretain権限を維持する。

Subscribeはtopicfilter ARN、Publish/Receiveはtopic ARNを使う。backendの購読filterは`+/ota-events`、Receive/PublishのPolicy ARNは`*/ota-events`等に限定する。Policyの`*`はMQTTの1階層制限ではないため、本文とtopicのdeviceIdも必ず検証する。[AWSのPublish/Subscribe例](https://docs.aws.amazon.com/iot/latest/developerguide/pub-sub-policy.html)と[Policy actions](https://docs.aws.amazon.com/iot/latest/developerguide/iot-policy-actions.html)を参照する。local匿名Mosquittoでは本人認証・権限分離を保証しない。

移行は(1) 型/schemaを配布、(2) OTA無効のまま保存/receipt・評価側を#170まで揃える、(3) Terraform planで権限差分を確認して承認後に選択Regionへ適用、(4) #168のsupervisorと公開鍵・baselineを手動導入し能力を確認、(5) #169以降のopt-in deploymentを先行機だけ承認、の順で行う。既存simulatorへ新topicを送らない。APIの権限追加だけでOTAを有効にしない。今回のTerraform検証はmock planで、実AWSへの適用・認可の実測・OTA実更新は行わない。

検証コマンド：`pnpm check`、`pnpm exec vitest run packages/protocol/test`、`terraform -chdir=infra/terraform fmt -check -recursive` / `init -backend=false` / `validate` / `test`。既存通信の回帰に加え、不正ID・state・時刻・version・fence・topic混入と、方向/自機制限を検証する。
