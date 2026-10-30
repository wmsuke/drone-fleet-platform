# OTAの制限付き再試行とrollback

#172で、停止中のtargetに対する復旧承認・新attempt・永続予算・復旧評価を追加した。通常の[段階配信](ota-rollout.md)や同じcommandIdの配送再送とは分ける。APIの202、旧版へのpointer切替、端末のAPPLIEDだけを回復成功にしない。

## 承認API

```http
POST /deployments/:deploymentId/targets/:targetId/recover
Idempotency-Key: recovery-demo-001
Content-Type: application/json

{"kind":"RETRY","reason":"TRANSIENT_DOWNLOAD_CONFIRMED"}
```

`kind`はRETRYまたはROLLBACK。理由は大文字英字から始まる大文字・数字・`_`、最大64文字とする。HTTP操作者はanonymousで、認証・認可は追加していない。ローカルまたは制限ネットワークで使用する。

復旧専用の`(anonymous, deploymentId, key)`内で同じtarget・kind・理由なら元の承認応答を返し、異なる要求は409にする。操作履歴、予算、attempt/fence、HELD outbox、auditを同一transactionに保存する。元のdeployment/target/release snapshotや失敗attemptを上書きしない。

許可時は202でrecoveryId、previousAttemptId、新attemptId、kind、status=WAITING、検出/総予算期限/実行可能時刻を返す。拒否の事実もUNAVAILABLE・failureReason・必要対応とともに保存し、409で返す。同key再送は元の202/409応答で、現在状態の再評価ではない。形式不正は400、不明targetは404、保存障害は503とする。

## 対象と前試行の確認

- deploymentはPAUSEDであることを要求する。停止受付だけのSTOPPINGや結果不明のWAITING_FOR_HUMANから勝手に始めない。復旧開始後も停止latchを解除せず、許可したtargetの復旧workerだけが配送する。
- 前attemptの評価FAILED、対応する直接STATE終端（FAILED/STOPPED/APPLIEDと稼働release/boot）、現在のdevice予約・fenceが必要である。UNCERTAIN、未知の子、観測不足、古い観測、別boot、適用継続の可能性がある場合は拒否する。
- 新鮮なINVENTORYのreadinessと復旧観測を照合する。RETRYは7項目全て、ROLLBACKはeventLoop/sqlite/MQTT/subscriptions/receiptsを必須とする。壊れた候補版のtelemetry/commandReadyを旧版の成功証明にせず、切替直前のPREPARE・排他条件は端末が別に確認する。
- 待機後も予約・新fence、前の稼働boot、能力・現在の信頼根・artifactを再検証する。観測が古くなった場合に、古い証拠や新しい期限で補完しない。

## retryのallowlistと上限

初期allowlistは、適用前の一時的download失敗だけである。DOWNLOAD_FAILEDのFAILED報告があり、VERIFIED以降の進捗やVERSIONがないことを確認する。署名/digest/互換性/容量/時刻/fenceの問題、結果不明、適用後の失敗は自動再試行しない。

端末はHTTP 429/5xxと一時的な接続失敗をDOWNLOAD_FAILED、redirect/恒久HTTP拒否・アドレス拒否等をDOWNLOAD_REJECTEDに分ける。分類できない内部例外はRESULT_UNKNOWNとし、安易に一時障害へ分類しない。archive取得は1attempt最大3回で、backendによる新attemptはtargetごと最大1回とする。

復旧許可から30秒＋0〜30秒jitterを一度だけ保存し、その後にworkerが新attemptの300秒開始期限・600秒結果期限・APPLY payloadを確定する。総予算内に600秒の結果期間を確保できなければ開始しない。復旧の承認は必須であり、障害検出だけを契機に自動再適用しない。

## 15分・256 MiBの永続予算

障害検出から15分、targetの累計download body bytesは256 MiB、同時復旧は1件とする。検出は最初の失敗評価と端末journalの記録の早い方を使い、待機や再起動・承認のやり直しで起点を更新しない。失敗自体が未確認の要求はUNAVAILABLEの検出時刻として要求の拒否時刻を残し、復旧を開始しない。

DBは元attempt・新attempt・承認時bytes・deadline・notBefore・復旧結果と根拠を保持する。新attemptを発行済みのkindは一意制約で再発行を拒否する。予算/理由/元応答とIDはtriggerで不変にし、観測bytesと根拠は巻き戻さない。SQLiteのtarget_budgetsも累計bytes、最初の検出/期限、retry/rollback使用数を永続化する。downloadのchunk受信前後・crashの観測不足を0へ補完せず、journalに予算がない旧attemptは復旧不可にする。

bytesはmetadataとarchiveの受信bodyを対象とし、同attempt内の再取得も合算する。256 MiB到達で追加取得を止め、超過chunkを受信した場合も実測値を保存して打ち切る。HTTP header/TLS/ネットワーク再送を含む課金量の厳密な計測ではない。転送上限を費用リスクの上限として使うが、通貨建て費用を取得したことにはせずcostはnullとする。実AWS課金上限の保証はしない。

通常配送と同じ全worker共通の同時2適用・claim 1件/秒、配送最大5回を使用する。同じcommandId/payload/期限のMQTT再送では新attemptや復旧回数を増やさない。明示停止とpublishも同じdeployment lockで直列化し、未送信の復旧を抑止する。送信済みの場合はSTOP/状態確認を継続し、停止受付を復旧成功にしない。

## rollback

ROLLBACKは自動起動せず、別の理由付き承認を必要とする。前試行の既知の終端と稼働boot、旧配信物の署名/鍵/size/digest、platform/runtime、双方のrollbackCompatibleと同じ共有stateSchemaRangeを確認する。現在のSQLite状態を過去へ巻き戻さず、破壊的migrationや不可逆な外部操作を許可しない。

端末のknownGood（手動bootstrapした既知正常版）が、target受付snapshotの旧releaseと一致する場合だけ使用する。実行前にも保持済みarchiveと展開済み内容を再検証し、容量・PREPARE・旧子終了を確認してatomic切替する。欠けた旧artifactを未確認のダウンロードで埋めない。現段階ではbackend成功からknownGoodを自動更新しないため、次のdeploymentの旧版と手動baselineが異なる場合もROLLBACK_UNAVAILABLEとなる。

rollbackも新attemptId/commandId・高いfenceを使い、目的ROLLBACKと原因/root attempt・recoveryIdを保存する。13標本/60秒・新boot/version/digest・fresh challenge healthは通常更新と同じ評価器で確認する。rollback成功はrecoveryのSUCCEEDED、targetのRECOVEREDであり、元releaseの更新成功へ加えない。deploymentは人間判断待ちのままとし、自動で段階を昇格・予約を解放しない。

旧版なし、失効鍵、非互換schema、容量不足、disk/journal破損、未知の実行ではUNAVAILABLE、実行後の明示失敗はFAILED、不足・期限超過はUNCERTAINとして必要対応を残す。rollbackの起動・health失敗を別rollbackで再帰的に直さない。retry失敗後の明示rollbackも、旧版と停止/予算の条件を満たす場合だけ各1回の範囲で許可する。

## 照会と移行

`GET /deployments/:deploymentId`のrecoveriesに、kind・status・原因/root/new attempt、検出/承認/待機/開始/終了時刻、総期限、bytes、cost、評価根拠、failureReason/requiredActionを追加した。元の評価履歴は残し、受付応答と実際の回復結果を分ける。#173の[人間介入記録](ota-interventions.md)で理由付き承認・拒否・判断対応をauditへ関連付ける。操作画面は#174の対象とする。

代表的な拒否理由はDEPLOYMENT_NOT_PAUSED、PREVIOUS_ATTEMPT_UNCONFIRMED、RECOVERY_OBSERVATION_MISSING、STOP_UNCONFIRMED、HEALTH_UNCONFIRMED、RETRY_NOT_ALLOWLISTED、RECOVERY_ACTIVE、RECOVERY_LIMIT_REACHED、DOWNLOAD_BUDGET_EXCEEDED、RECOVERY_TIME_BUDGET_EXCEEDED、ROLLBACK_UNAVAILABLEである。原因を確認し、必要に応じて手動の退避・復元・交換へ引き継ぐ。元の予算や同IDの期限を延長して解消しない。

OTA無効の状態でmigrationとprotocol/ingestor/API/supervisorを揃える。APPLYに任意のrecovery情報を追加し、ROLLBACKでは必須とする。INVENTORYにも任意のknownGood・phase・attemptId・累計bytes・検出/期限を追加する。旧形式は引き続き通常観測・更新に使えるが、証拠不足の復旧は拒否する。新しいtopicやAWS権限は追加しない。OTA_ENABLEDには配信物/信頼根設定も必要である。

## 検証範囲

専用PostgreSQLのAPI統合テストは、許可/禁止・freshness・排他・待機/再起動・予算・冪等承認・HTTP照会・audit失敗時のrollback、旧versionの評価SUCCEEDEDと元失敗の分離、rollback失敗/不能を検証する。backendの13標本/60秒評価は保存イベントと制御clockによるfixtureで検証する。

`pnpm test:ota-device`では実Linuxアプリを更新し、receipt経路を遮断してhealth失敗を検出し、保持した旧bundleへ明示rollbackして別bootと60秒のlocal healthを確認する。旧鍵の無効化、SQLite budgetの再起動維持も別テストで確認する。`pnpm test:ota-backend`は既存の実MQTT/DB/異なるbundle・backend再起動・成功評価を回帰する。これを実MQTT経由のrollback一貫検証へ読み替えない。10台の全障害E2Eは#175、実AWSのOTAと実機は未検証である。
