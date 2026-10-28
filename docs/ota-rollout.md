# OTAの段階配信と停止

#171で理由付きの段階承認、APPLYの永続配送、停止・再開と集約を追加した。更新成功は[証拠評価](ota-evaluation.md)で判定し、配信停止とrollbackは分ける。初期設定は自動昇格なしである。

## API

`POST /deployments`の[固定snapshot受付](deployments-api.md)後、次を使う。全操作に`Idempotency-Key`と`{"reason":"LOCAL_DEMO"}`形式の理由コード（英大文字から始まる英大文字・数字・`_`、最大64文字）が必要である。actorはanonymousのままで認証・認可ではない。管理APIを公開しない。

| 操作 | API | 条件・意味 |
| --- | --- | --- |
| 段階承認 | `POST /deployments/:deploymentId/stages/:stageId/approve` | AWAITING_APPROVALだけを解禁する。先行開始も承認が必要 |
| 配信停止 | `POST /deployments/:deploymentId/stop` | STOPPINGの受付。未送信の抑止であり、全機体の停止完了ではない |
| 明示再開 | `POST /deployments/:deploymentId/resume` | PAUSEDで現状・所有fence・予約・信頼根/配信物・能力・観測鮮度・元期限を再検証する |

成功は202でactionId、deploymentId、stageId（該当時）、action、受付時のstatus、createdAtを返す。`(anonymous, deploymentId, key)`内で同じ操作・理由・stageなら元の応答を返す。異なる本文は409。再送は再承認・再適用・現在状態の照会にならない。要求形式は400、不明deploymentは404、状態・証拠・期限の不成立は409、DB等の障害は503とする。

主な409は`STAGE_NOT_READY`、`PREVIOUS_STAGE_UNCONFIRMED`、`DEPLOYMENT_STOPPED`、`STOP_UNCONFIRMED`、`DEVICE_OTA_UNCONFIRMED`、`RELEASE_OR_DEVICE_UNAVAILABLE`、`FENCE_OR_RESERVATION_CONFLICT`、`ATTEMPT_EXPIRED`、`NEW_ATTEMPT_REQUIRED`である。状態不成立を同IDの期限延長や新attempt作成で回避しない。

## 段階と配送

固定したstageの全N台が目的releaseの評価SUCCEEDEDになり、現在のINVENTORY、VERSIONとchallenge HEALTHのrelease/bootが一致し、観測とhealthが15秒未満の場合だけPASSEDへ進む。次stageはAWAITING_APPROVALになり、人が承認するまでHELDのままである。承認直前にも全先行stageの現在状態を再確認する。失敗・未応答・未送信を分母から除かない。

承認transactionでそのstage全attemptの開始時刻、300秒の開始期限、600秒の結果期限、不変APPLY payloadを一度だけ確定する。stageが大きくても待機機体の期限は延長しない。全stageの現在成功を確認したCOMPLETED transactionでのみdevice予約を解放する。途中成功やPAUSEDでは保持する。

APIのopt-in OTA monitorが既存QUERY/評価走査に加えてAPPLY/STOP outboxを走査する。`OTA_ENABLED=true`と従来の配信物・信頼根設定を使う。MQTT/DB切断後も同じcommandId・payload・期限を使い、送信前に試行数と次回時刻をcommitする。最大5回、1〜8秒上限のbackoff/jitterで再送し、受領後は適用を送り直さず結果を待つ。

DBの共通claim lockで全deployment合計の同時適用を2台、新規/再送claimを合計1件/秒に制限する。空きslotには未送信targetを優先する。PUBACKや開始期限切れだけではslotを空けない。成功評価、停止確認、またはFAILEDの直接STATE終端確認で占有を終了する。UNCERTAINをlease切れで空き扱いにしない。送信速度はclaimの制限であり、ネットワーク遅延後の受信間隔や性能を保証しない。

## 停止と確認

固定stage分母Nに対し、FAILED・開始期限切れ・停止に伴う未成功が10%以上（境界を含む）で停止する。1件のUNCERTAIN、結果期限超過、integrity/fence違反でも直ちに止める。復旧・遅着で分子が減ってもlatchは自動解除しない。10%未満でも全N成功を満たさないstageは昇格せず、全処理が確定した段階で停止・確認へ移す。

承認、停止、claim、publish直前確認、ingestorの評価は同じdeployment lockを使う。publish中もlockを保持するため、その要求の送信と停止受付の順序が決まる。送信前にclaim済みでも、停止が先にcommitしたAPPLYは外へ出さない。既にpublishした要求は取り消せないため、同attempt/fenceへの別commandIdのSTOP_UPDATEを永続化する。送信中のlock保持は既存publisherのtimeout内であり、HTTP停止受付がその分待つ場合がある。

STOPは最大5回、作成から30秒以内に送信する。対応する送信済みSTOPのSTOPPED通知と、その後のQUERY_STATEによるSTOPPED・実稼働release/bootの報告を照合して確認する。任意commandIdの停止通知では進めない。成功評価と新鮮なhealth、または直接観測したFAILED終端も処理終了の根拠にする。全処理中targetの確認後だけPAUSEDとする。

STOP受領だけ、PUBACKだけ、期限超過だけでは停止完了にしない。60秒の確認期限後も不明ならWAITING_FOR_HUMANとして予約を保持する。STOPがAPPLYより先に届いた端末のtombstoneは後着適用を防ぐが、端末が実状態を報告できなければサーバーは確認済みに補完しない。STOPPEDは更新手順の停止であり、子アプリや機体の物理的な安全停止を意味しない。適用済み版を自動rollbackしない。

## 再開・記録・境界

未適用機体の再開には、現在INVENTORYの任意`readiness`にある7項目すべての成功も要求する。旧形式・チェック不足・別boot/version・15秒以上前の観測は`HEALTH_UNCONFIRMED`で拒否する。これは適用前の現状確認であり、更新成功の13標本/60秒を代替しない。

未送信のまま止めた未期限切れattemptは、現在状態の検証後に元payloadと期限のまま再開できる。未解禁stageは承認待ちを維持する。STOPを発行したattempt、失敗・不確定、期限切れの再適用には新attemptが必要で、今回は409で拒否する。自動retry/rollbackと予算管理は#172の範囲である。残予算が存在しないことを架空の0消費や新しい期限で補わない。

`ota_actions`は理由・冪等要求hash・元応答を不変記録にし、成功auditも同じtransactionで保存する。必須承認、手動停止/再開、自動停止（system `ota-worker`）を区別する。`ota_rollouts`は現在の停止latch、`ota_dispatches`は全worker共通のclaim、`ota_stops`は不変STOP payload・再送・確認eventを保持する。評価はrevision採番で並べ、同一ミリ秒内の評価がUUID順で逆転しないようにする。既存評価はmigration時に従来の時刻/ID順で採番し直す。

`GET /deployments/:deploymentId`にcontrol（停止時刻/理由）、直近100件の手動操作、attemptごとのSTOP期限・再送数・確認eventIdを追加した。既存の実稼働構成・評価根拠と併せて参照する。画面とinterventionの詳細は#173/#174で追加する。

自動QUERYの144件/attempt・元結果期限後60秒までという既存予算は維持する。長時間承認待ち等で照会予算が尽きてhealthが古い場合は昇格・再開を拒否する。成功履歴を鮮度の代わりにしない。未確認状態を運用者が照合する経路・新attemptは後続Issueが必要となる。

## 検証

専用PostgreSQLの`pnpm api:test:integration`で、先行評価/承認gate、固定Nの10%境界と9%/UNCERTAIN、複数workerのslot/速度、停止と送信の競合、再開・失効鍵・期限・STOP確認・予約解放を検証する。集約テストの成功入力は評価済み証拠fixtureで、60秒評価そのものは既存の証拠評価テストで検証する。

`pnpm test:ota-backend`は実MQTT・DB・Linuxの異なる実bundleを使い、公開承認API→永続APPLY worker→実適用→保存receipt再送→backend再起動→60秒health評価→COMPLETEDを確認する。専用container/network/volumeは終了時に削除する。10台1/3/6と全障害注入は#175、復旧は#172、実AWSのOTA・実機は未検証である。
