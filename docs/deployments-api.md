# OTA deploymentの受付API

#169で`POST /deployments`を追加した。対象・配信物・段階・health/停止/復旧方針を受付時に固定する。HTTP 202は受付の完了であり、配信開始・端末の適用・更新成功ではない。

## 有効化と現在の範囲

DB migrationを適用し、配信物管理と同じ`OTA_RELEASE_DIR` / `OTA_TRUST_STORE_PATH`をAPIへ設定する。両方が未設定ならこのrouteは登録しない。署名鍵はAPIへ渡さない。認証・認可は追加していないため、管理APIを外部公開しない。

受付時は先行stageも承認待ちで、全attempt/outboxは`HELD`になる。開始時刻・開始期限・結果期限・送信payloadはnullのまま保存する。#171で[理由付き承認・段階配信・停止/再開](ota-rollout.md)を追加した。HTTP内ではMQTT送信せず、明示承認後にopt-inのOTA workerが配送する。通常command outboxとは別tableなので、既存workerがOTAを誤配信することもない。

端末の現在版・能力を保存する`ota_device_states`には既定値を挿入しない。通常simulatorのtelemetryからOTA対応やversionを推測しない。#170でopt-in supervisorの実観測INVENTORYを登録する経路を追加した。[観測・評価手順](ota-evaluation.md)を参照する。旧simulatorなど未観測の機体は`DEVICE_OTA_UNCONFIRMED`で拒否する。versionや観測時刻を手作業で捏造しない。

## 要求

```http
POST /deployments
Content-Type: application/json
Idempotency-Key: ota-demo-001

{
  "releaseId": "d830dc2d-71ee-4c90-ae91-c33b43d8b136",
  "deviceIds": ["ota-drone-001", "ota-drone-002"],
  "groupIds": [],
  "evaluationVersion": "ota-health-v1"
}
```

- `deviceIds`と`groupIds`は併用できる。少なくとも一方を指定する。groupは受付transaction中のmembershipとrevisionを保存し、後の追加・削除・group論理削除で対象を変えない。
- deviceIdをASCII順に固定し、既定stageは先行1台、次に最大3台、残り全台。10台なら1/3/6で、空stageは作らない。
- 明示する場合は`stages: [{ "deviceIds": ["ota-drone-001"] }, { "deviceIds": ["ota-drone-002"] }]`の順序付き配列を使う。各stage内は正規化してASCII順にし、stageを連結した列が全対象のASCII順と一致する必要がある。漏れ・重複・空stage・逆順を拒否する。
- 100台・10stageが上限。複数groupの重複、groupと明示deviceの重複も全件拒否し、暗黙の重複除去や一部受付はしない。空groupも拒否する。
- health/停止閾値を弱める任意設定は受け付けない。`evaluationVersion`は省略時も`ota-health-v1`。30秒の起動確認、5秒間隔・13標本・60秒・gap最大10秒・鮮度15秒、全対象成功による昇格、失敗率10%以上/不確定・integrity失敗時の停止latch、承認必須、同時適用上限2台をsnapshotに持つ。復旧は自動無効・rollbackは明示承認とし、将来の復旧予算15分/256 MiB・新attempt最大1回を保持する。評価は#170、段階/停止は#171で実装し、制限付き復旧は#172で追加する。

## 冪等性と検証

idempotency scopeは`anonymous`、keyはASCII英数字・`_`・`-`の1〜128文字とする。UUIDの小文字化、device/group選択順、stage内順序、既定値を正規化した本文とSHA-256を保存する。同key・同本文は元の受付応答を202で返す。membershipやtrust storeが変わっても再受付・再検証・新attemptは行わない。同keyの異なる本文は409。stageの順序は意味を持ち、正規化で入れ替えない。

新規要求はDBの共通lockとcommit済み受付時刻によりAPI replica間で1秒に1件に制限する。再送はこの制限より先に照合する。本文不一致、対象予約、通常command受付の競合はDBで直列化し、同keyの並行要求でもdeployment/attemptを二重作成しない。

新規受付では現在のtrust store、署名、配信objectのsize/digestを再検証する。各機体は15秒未満の観測済み現在版・能力が必要で、将来時刻・不明version・非対応・不一致platform/runtime/schema・同版/旧版への通常更新・fence上限は拒否する。現在版のreleaseId/version/buildId/digest/platformも登録済みreleaseと照合する。古いtelemetryのIDLEを安全証明にはせず、適用直前の通常command停止可否はsupervisorが別に確認する。

## 保存と予約

`ota_deployments`、`ota_stages`、`ota_targets`、`ota_attempts`、`ota_outbox`、`ota_reservations`と受付auditを同一transactionで保存し、機体ごとのfenceを増やす。途中やauditの保存失敗では全体をrollbackする。未解禁を含む全targetをdeviceId一意で予約する。deployment/stage/targetのsnapshotはDB triggerで変更不可とし、状態だけを分離する。attemptのID/fenceと、発行後の期限・payloadも変更不可とする。

予約中の機体への`POST /devices/:deviceId/commands`は409、予約機体を1台でも含む`POST /fleet-operations`も全受付を409で拒否する。fleet operationの同key再送は新操作ではないため元応答を返す。予約前に受付済みの通常commandを取消したことにはせず、端末側gateと終了確認を併用する。

予約の自動TTLはない。#171で全対象の目的release成功と現在状態を確認したCOMPLETED transactionだけで解放する。PAUSED/STOPPING/WAITING_FOR_HUMANやlease切れだけでは解放しない。検証は専用DBで行い、共有デモの機体を試しに予約しない。

受付で受領・適用・health・成功eventを生成しない。#170でeventの採否、DB保存receipt、challenge、評価と一覧/詳細APIを追加した。`GET /deployments` / `GET /deployments/:deploymentId`の進捗・根拠・期限の見方は[証拠評価](ota-evaluation.md)を参照する。元のcommand/ACK・telemetryの意味は変更しない。

## 応答とエラー

202はdeploymentId、`status: ACCEPTED`、targetCount、createdAt、不変release envelope、policy、stageId/順序/初期状態/deviceIdsを返す。同key再送でも「元の受付事実」を返すため、これを進行状況の照会として使わない。進捗GETは[証拠評価](ota-evaluation.md)、承認・停止・再開APIは[段階配信](ota-rollout.md)を参照する。

| status | 主なerror |
| --- | --- |
| 400 | INVALID_DEPLOYMENT_REQUEST / EMPTY_TARGETS / DUPLICATE_TARGETS / TARGET_LIMIT_EXCEEDED / INVALID_STAGES |
| 404 | GROUP_NOT_FOUND / DEVICE_NOT_FOUND / RELEASE_NOT_FOUND |
| 409 | IDEMPOTENCY_CONFLICT / DEVICE_RESERVED / DEVICE_OTA_UNCONFIRMED / INCOMPATIBLE_DEVICE / RELEASE_UNAVAILABLE |
| 429 | DEPLOYMENT_RATE_LIMITED（Retry-After: 1） |
| 503 | DEPLOYMENT_UNAVAILABLE |

成功auditは`deployment.accepted`、再送は`deployment.replayed`。actorはanonymousのままで本人性を保証しない。要求本文・配信物・署名鍵・file pathをaudit metadataやエラー応答へ出さない。拒否時auditの必達は既存と同様に保証しない。

## 検証

#174の[配信画面](ota-dashboard.md)向けに、詳細の各targetへ最新の採用済みINVENTORYの`observation: {receivedAt,payload}`を追加した。欠落・解析不能ならnullとし、進捗や成功証拠へ流用しない。一覧には同時刻のcursorに使うbeforeId/nextBeforeIdを追加した。既存のbeforeのみの照会は維持する。

承認・停止・再開・復旧要求のinterventionIdと判断対応・履歴取得APIは[人間介入記録](ota-interventions.md)を参照する。deployment詳細にはinterventionSummaryを追加し、既存の操作に介入詳細がない場合も自律完了から除外する根拠を残す。

`pnpm check`と専用PostgreSQL上の`pnpm api:test:integration`で、snapshot保持、同keyの同時受付、予約gate、上限・重複・非互換・失効鍵、途中保存失敗のrollbackを確認する。実MQTT配送・端末適用・backend成功評価・実AWSのOTAをこのAPIの検証済み範囲に含めない。
