# OTAの人間介入記録

#173で段階承認・手動停止/再開・retry/rollback承認・判断待ちの対応記録を追加した。通信仕様と端末の成功条件は変更しない。

## 操作との保存整合性

既存のapprove/stop/resume/recover APIは、操作・状態変更・`ota_interventions`・auditを同じtransactionで保存する。応答へ`interventionId`を追加し、同じIdempotency-Key・正規化本文の再送では元の応答を返す。異なる本文は409となる。復旧要求がUNAVAILABLEとなる場合も拒否された介入を保存し、実行したとは扱わない。入力不正や状態不成立で操作自体を受け付けなかった要求は介入回数へ追加せず、拒否auditは既存のbest-effort境界を引き継ぐ。

| kind | category | 操作結果の意味 |
| --- | --- | --- |
| STAGE_APPROVAL | REQUIRED_APPROVAL | 必須の段階承認を受け付けた。機体の更新成功ではない |
| STOP / RESUME | FAULT_RESPONSE | 配信制御要求を受け付けた。STOPは物理停止確認ではない |
| RETRY_APPROVAL / ROLLBACK_APPROVAL | FAULT_RESPONSE | 新attemptの許可または拒否。回復成功ではない |
| HUMAN_REVIEW | FAULT_RESPONSE | 人間判断待ちへの対応開始・判断結果 |

通常の承認も人間が介在した事実として残す。段階承認と障害対応を分けたまま、いずれも`excludesAutonomousCompletion: true`とする。自動停止、workerの再走査、transport再送は人間介入を増やさない。復旧の進行・評価は元のrecoveryに追記し、承認事実を成功へ書き換えない。

## 判断対応API

管理APIが有効な既存のdeployment APIに追加する。両POSTはIdempotency-Keyと理由コード（`^[A-Z][A-Z0-9_]{0,63}$`）を必須とし、本文は最大2048 bytes、未定義項目を拒否する。

- `POST /deployments/:deploymentId/interventions`：`{"reason":"INSPECTING"}`で対応開始。PAUSEDまたはWAITING_FOR_HUMANだけを許可し、同じdeploymentの未終了対応は1件に制限する。202でinterventionId・deploymentId・startedAtを返す。同じkeyの再送は終了後も元の開始応答を返す。
- `POST /deployments/:deploymentId/interventions/:interventionId/complete`：`{"reason":"NEEDS_ONSITE_INSPECTION","outcome":"ESCALATED"}`で対応判断を記録する。202で終了時刻と判断結果を返す。終了keyのscopeは対象interventionで、同じkey・本文だけを再送できる。終了後の上書きは409となる。

outcomeは`KEEP_STOPPED`（停止維持を判断）、`ESCALATED`（現地調査等へ引き継ぐ）、`RECOVERY_REQUESTED`（明示的な復旧要求へ引き継ぐ）。最後の場合だけ`recoveryId`を必須とし、同じdeploymentで対応開始後に受け付けた、新attemptを持つ復旧要求を検証する。任意の別deploymentの復旧や、拒否された要求を解消根拠にはできない。

対応判断の終了と、障害・機体状態の解消は別である。このAPIだけではWAITING_FOR_HUMAN・停止latch・予約・評価を変更しない。対応中も既存のstop/recover APIを利用する。物理状態を確認できない場合はESCALATEDまたはKEEP_STOPPEDとして引き継ぎ、単なる確認ボタンで予約を解放しない。復旧要求への引き継ぎ後も、回復成功は既存の証拠評価を待つ。

不正本文/ID/keyは400、未存在または別deploymentの対象は404、二重対応・状態不成立・key衝突・過大な作業時間・不正な復旧参照は409、DB保存失敗は503となる。GETはreadonly transactionで状態を変更しない。

## 記録と取得

`GET /deployments/:deploymentId/interventions?limit=20`で開始時刻とinterventionIdの降順に取得する。limitは1〜100。続きは応答の`nextCursor.startedAt`と`nextCursor.interventionId`を、それぞれ`before`と`beforeId`へ指定する。両項目は組で必須とし、同時刻の記録もIDで区別する。全履歴を取得するにはnextCursorがnullになるまで進む。

各記録には次を含む。

- interventionId、deploymentId、stageId/targetId/attemptId、actionId/recoveryId。複数機体の承認・停止・再開は`scope`に操作時のtargetId/attemptIdを固定する。後から最新attemptへ差し替えない。
- actorKind/actorId、kind/category、理由、操作結果、開始/終了、auditEventId/completionAuditEventId。auditのmetadataにもinterventionIdを含む。
- durationMsとdurationSource、cost。取得できない費用・作業時間はnull。
- 復旧承認の場合は、recoveryの検出/開始/終了時刻、状態、転送bytes、費用、証拠event ID、失敗理由と次の必要対応。元更新の失敗と旧版回復の成功を区別する。

開始/終了はサーバーが記録した受付時刻で、人間の実作業時間ではない。同期操作の開始/終了が同時刻でもdurationMsを0にしない。HUMAN_REVIEW終了時に限り、利用者が取得した作業時間を任意の`durationMs`で報告できる。非負の安全な整数で受付開始〜終了を超えない値だけを許可し、`durationSource: OPERATOR_REPORTED`とする。未報告・未終了の時間はnullのままとし、経過時間を作業時間へ補完しない。費用の入力・単価設定・実請求の取得は追加していない。

deployment詳細の`interventionSummary`は必須承認/障害対応/未終了対応の件数と、既存operationに介入詳細が欠ける`legacyOperationCount`を返す。migration前のactor・時間・audit関連を捏造してbackfillしない。旧操作も自律完了の除外根拠に含める。除外根拠がないことは自律完了の証明ではなく、この記録だけで過去の人間操作を網羅できない。KPI集計やOTA専用画面は後続Issueとする。

## 信頼境界

#174の[OTA画面](ota-dashboard.md)で介入履歴・auditと判断対応を追跡できる。画面でも受付開始/終了・自己申告作業時間・不明費用を区別し、対応終了を端末の回復成功にしない。

HTTP actorは既存同様`anonymous / null`で、本人・権限を認証できない。X-Actor-Id等のheaderや本文からactorを採用せず、requestIdもサーバー発行の相関IDに限る。対応の開始者と終了者が同一人物であることも保証しない。APIはローカル・制限ネットワーク専用であり、公開や実機運用には認証・対象単位の認可が別途必要となる。

同じdeployment lockで並行要求を直列化し、操作と介入/auditの片方だけを保存しない。FK・scope検証・一度限りの終了更新で別deploymentへの誤関連や既存の介入内容の上書きを拒否する。DB ownerによる削除・trigger無効化への改ざん耐性は保証しない。自由文・payload全文・秘密値は保存せず、idempotency key/hashは取得APIに出さない。

## 検証範囲

PostgreSQLのmigration、承認/停止/再開/復旧との関連、要求再送・並行要求、操作/audit/介入の保存失敗、対応開始・終了、入力・scopeの検証、履歴ページング、不明値の維持を結合テストで検証する。ローカルの記録処理であり、今回の検証を実AWSのOTA・本人認証・実機安全保証へ読み替えない。
