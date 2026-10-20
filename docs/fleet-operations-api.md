# グループ操作の受付・集約API

#139でgroupの現在の構成を固定し、対象ごとのcommand/outboxを作る受付API、#152で[実行結果通知](command-results.md)、#140で一覧・詳細と結果集約、#141で[操作・結果追跡画面](fleet-operations-dashboard.md)を追加した。受領ACKを完了結果へ読み替えない。

## 要求と応答

`POST /fleet-operations`に次を送る。`Idempotency-Key`は必須で、1〜128文字のASCII英数字・ハイフン・アンダースコアとする。新しい操作には新しいkeyを使う。

```http
POST /fleet-operations
Content-Type: application/json
Idempotency-Key: demo-operation-001

{"groupId":"c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55","type":"RETURN_HOME"}
```

groupIdはUUIDで、小文字へ正規化する。typeは既存の`RETURN_HOME` / `REBOOT`。未知のbody項目やクライアント申告actorは拒否する。

受付成功は202で返す。

```json
{
  "operationId": "6957ca77-f1d7-4598-863a-28faf7496f62",
  "groupId": "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55",
  "type": "RETURN_HOME",
  "status": "ACCEPTED",
  "targetCount": 100,
  "createdAt": "2026-10-14T00:00:00.000Z",
  "expiresAt": "2026-10-14T00:00:30.000Z",
  "resultDeadline": "2026-10-14T00:02:00.000Z"
}
```

`ACCEPTED`はDBへの受付成功であり、送信・受領・操作完了ではない。同じ要求の再送も元の受付結果を202で返す。現在の進行状況を示す応答ではない。進行状況は以下のGET APIで取得する。

## 一覧・詳細

`GET /fleet-operations`は`{items, total, limit, offset, evaluatedAt}`を返す。itemsはoperationの集約結果で、target一覧は含めない。totalは絞り込み後・ページ分割前のoperation数。createdAtの降順、同時刻はoperationIdの降順で並べる。

| Query | 内容 |
| --- | --- |
| limit | 1〜100。既定20 |
| offset | 0〜1,000,000。既定0 |
| groupId | UUID。受付時のgroupId。削除済みgroupも検索できる |
| type | RETURN_HOME / REBOOT |
| status | ACCEPTED / IN_PROGRESS / COMPLETED / PARTIALLY_FAILED / FAILED |
| from / to | UTC ISO 8601。受付createdAtの範囲、両端を含む。from > toは拒否 |

`GET /fleet-operations/:operationId`は集約結果に`evaluatedAt`と`targets: {items, total, limit, offset}`を加えて返す。targetはdeviceIdのASCII順。limitは1〜100（既定100）、offsetは0〜1,000,000（既定0）。statusには下表のtarget状態、deviceIdには完全一致を指定できる。totalはtargetの絞り込み後の件数で、operation全体のtargetCount・countsは絞り込みで変わらない。

```http
GET /fleet-operations?groupId=c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55&status=IN_PROGRESS&limit=20
GET /fleet-operations/6957ca77-f1d7-4598-863a-28faf7496f62?status=UNRESPONSIVE&limit=10&offset=0
```

集約結果はoperationId、groupId、受付時のgroupName・groupRevision、type、status、targetCount、createdAt、expiresAt、resultDeadline、updatedAtを持つ。countsは下表の全10状態をキーとする件数（0も返す）。succeededCount、unsuccessfulCount、inProgressCountの合計はtargetCountに一致する。acknowledgedCountは受領時刻を持つtargetの別指標で、状態別件数へ重ねて加えない。

targetはdeviceId、commandId、表示status、commandStatus（配送・受領）、executionStatus（実行正本）、outboxState、attempts・failures、sentAt、acknowledgementReceivedAt、executionStartedAt・executionStartedReceivedAt、executionResultAt・executionResultReceivedAt、updatedAtを返す。未記録の時刻・outboxStateはnull。秘密情報、key、outboxのtopic・payloadは返さない。

GETは不正なID・query・未知のquery項目・重複queryを400、存在しないoperationを404で返す。空の検索結果や範囲外offsetは200でitemsを空にし、totalは維持する。DB障害は500であり、空結果・404へ置き換えない。GETにIdempotency-Keyは不要。

### 状態の評価

一つのSQL statement・同一DB snapshot・同一サーバー評価時刻evaluatedAtで、command/outboxの正本、全体の件数、絞り込み後の件数、pageを読む。状態をtargetへ二重保存せず、ACK・実行結果・outboxのcommit後は次のGETへ反映する。group membership・現在の名称・接続状態・telemetryは集約に使わない。

上から最初に一致する状態を使う。

| 根拠 | target状態 | 分類 |
| --- | --- | --- |
| 実行SUCCEEDED | SUCCEEDED | 成功 |
| 実行FAILED | EXECUTION_FAILED | 不成功・実行失敗 |
| 実行UNCERTAIN | UNCERTAIN | 不成功・結果不明 |
| 配送EXPIRED | EXPIRED | 不成功・開始期限切れ |
| evaluatedAt >= resultDeadlineで終端結果なし | UNRESPONSIVE | 不成功・受領または結果未応答 |
| 期限前の実行RUNNING | RUNNING | 進行中 |
| 期限前の受領時刻あり | ACKNOWLEDGED | 進行中・結果待ち |
| 配送FAILED / TIMED_OUT | DELIVERY_FAILED / UNRESPONSIVE | 不成功・送信失敗 / 受領未応答 |
| 配送SENT | SENT | 進行中・受領待ち |
| 配送PENDING | PENDING | 進行中・送信待ち |

全targetがPENDINGなら全体はACCEPTED。それ以外で進行中があればIN_PROGRESS、全件成功ならCOMPLETED。進行中がなく成功・不成功の両方があればPARTIALLY_FAILED、成功0ならFAILED。不成功には期限切れ・結果不明も含み、全機体の物理的な操作失敗を断定しない。EXPIREDも一度も操作していない証明ではない。

結果確認期限は受付から120秒で、開始期限30秒とは別。workerが遅れてもGETで未応答を評価するが、commandの正本や開始期限は変更しない。配送FAILED/TIMED_OUTの後でも、有効なRUNNING・受領ACKが保存されれば期限前は進行中へ戻る。期限ちょうど・期限後はRUNNING・受領だけでは未応答を解消しない。後着SUCCEEDED/FAILEDは期限後も反映し、UNCERTAINも確かな終端結果で解消する。衝突通知はingestorで正本へ適用しないため集約にも使わない。

updatedAtはcommand作成・送信・受領・期限判定・有効な実行通知のサーバー受信時刻、およびoutboxの配送試行更新時刻の最大値。未応答の期限評価ではresultDeadlineも候補に含め、単にGETした時刻や端末時刻・将来のnextAttemptAtは使わない。operationは全targetの最大値を返す。

集約は現在の評価であり、後着結果でFAILED/PARTIALLY_FAILEDからCOMPLETEDに変わり得る。GETは書き込みをしない。#144で独立したaudit workerが集約状態の変更とcheckpointを記録し、初めて終端表示を観測した時刻を保持する。周期間の中間状態をすべて記録する保証ではない。詳細は[audit log](audit-log.md)を参照する。

page間の別リクエストは別snapshot・別評価時刻である。状態変化や新規受付によりoffsetの対象がずれる場合は先頭から更新する。全履歴をまたぐ大規模な性能保証やcursor、集約キャッシュは追加していない。

## 対象と保存境界

transactionで同じscope/keyのadvisory lockを取り、既存operationを照合してからgroup行をロックする。membership変更・group更新・論理削除も同じgroup行をロックするため、対象とgroup名・revisionが一貫した時点で固定される。OFFLINEも対象に含める。

`fleet_operations`へgroupId、受付時の名前・revision、type、scope/key、対象数、時刻・期限、未認証actor種別を保存する。`fleet_operation_targets`はoperationとdevice、固有commandIdの関係を保存し、membershipから独立させる。commandとoutboxは対象数に比例する個別queryではなくbatch INSERTする。全行を同じtransactionでcommitし、途中失敗ではすべてrollbackする。

commit後のmembership変更やgroup論理削除で対象を変えない。group・operation・target・commandの外部キーは履歴の物理削除を制限する。targetごとの状態はcommandを正本とし、ここでは二重保存しない。

開始期限は全command共通で受付時刻から30秒。結果確認期限はoperation共通で120秒を保存するが、#139では結果を評価しない。HTTP中にMQTT接続やpublishはせず、既存outbox workerに渡す。workerの送信待ち、接続・再送により一部が開始期限に間に合わないことがある。100台受付の成功は100台の配送成功を保証しない。

## 冪等性とエラー

現在のscopeはサービス固定の`anonymous`。同じscope/keyかつgroupId/type一致なら、現在のmembershipやgroup削除状態にかかわらず元operationを返す。異なる要求は409。同時要求はkeyごとのtransaction lockで待機・照合し、DBのscope/key一意制約も二重受付を防ぐ。lock用hashが衝突した場合は無関係な要求の待機が増えるだけで、要求の一致判定は保存値で行う。

rollbackしたkeyは消費しない。応答を失ったときは同じkeyで再送し、新しいkeyを作って二重操作にしない。keyと受付結果は自動削除しない。本人確認は未実装であり、keyやactorを認証の代わりにしない。APIはローカルまたは制限したネットワークで利用する。

| Status | 条件 |
| --- | --- |
| 400 | 不正入力・keyなし・対象数上限超過 |
| 404 | 存在しないgroup |
| 409 | 空group、削除済みgroup、同じkeyの要求不一致 |
| 500 | DB保存などの予期しない失敗。commitが不明なら同じkeyで照合する |

`FLEET_OPERATION_MAX_TARGETS`は既定100、設定範囲1〜1000。上限+1件までmembershipを取得して超過を判定する。1000は設定上限であり性能保証ではない。起動時に不正設定を拒否する。成功時のログにtargetCount、transaction完了までのdurationMs、replayedを出す。認証情報・要求本文・keyは計測ログに出さない。#144で受付auditと各command audit、集約checkpointを同時commitする。冪等再要求はoperation.replayedとして元IDを記録する。

## 検証と実測

2026-10-14、macOS / Apple M2 / arm64 / memory 17179869184 bytes、Node.js 24.21.0、pnpm 10.28.1、OrbStack、PostgreSQL 17.11で実施した。専用DB・localhost:55439を使用し、MQTT workerを起動せず全100台をOFFLINEとして受付を計測した。

| 回 | 対象数 | 受付時間（ms） | Drizzle query数 |
| --- | ---: | ---: | ---: |
| 1 | 100 | 21.563 | 8 |
| 2 | 100 | 20.505 | 8 |
| 3 | 100 | 24.808 | 8 |

新規keyで3回実行した。時間はrepository呼び出しからtransaction commitを含む応答生成まで。query数はDrizzle loggerによる実測で、lock、照合、group取得、membership取得、4つのINSERTを数える。postgres.jsのBEGIN / COMMIT、接続準備、fixture・cleanupはquery数に含めない。HTTP転送、MQTT配送、受領、実行完了、1,000台負荷を測ったものではない。#144以後はauditの一括INSERT 2件と集約checkpoint 1件が加わり、問い合わせは対象数によらず固定11件になる。この表はaudit追加前の実測値である。

再現には専用PostgreSQLの`POSTGRES_*`と`DATABASE_INTEGRATION=true`を設定して`pnpm api:test:integration`を実行する。実測値を表示する場合は`pnpm exec vitest run --no-file-parallelism --silent=false apps/api/test/fleet-operation-repository.integration.test.ts --reporter=verbose`を使う。テストでは同時再要求、要求不一致、構成変更競合、group削除後の再要求、途中保存失敗・全件rollback、上限と既存単一device受付も確認する。migrationは`pnpm db:test:integration`で既存経路も検証する。

### #140の集約検証

2026-10-14、同じmacOS / Apple M2 / Node.js 24.21.0 / pnpm 10.28.1 / OrbStack環境の専用PostgreSQL 17（localhost:55440）で実施した。詳細APIのrepository呼び出しを測定し、返却pageは最大10台とした。

| 保存対象数 | 返却target数 | 取得時間（ms） | Drizzle query数 |
| --- | ---: | ---: | ---: |
| 1 | 1 | 5.728 | 1 |
| 100 | 10 | 4.997 | 1 |

集計はpageだけでなく全targetを対象とし、一覧も1 queryだった。query数はDrizzle loggerで測定した。fixture作成・HTTP転送・MQTT配送・連続負荷は含めず、この単発値を性能保証としない。この時点では大規模な履歴件数や1,000台は未検証だった。後続#146の[負荷結果](load-testing/fleet-commands.md)では10/100台の各3条件と追加1,000台を測り、1,000台の未達試行も記録した。通常上限100を維持し、長期履歴は引き続き未検証とする。

`DATABASE_INTEGRATION=true pnpm api:test:integration`で10状態の優先順位・件数、一部/全件不成功、期限前後の後着証拠、UNCERTAIN解消、期限拒否・終端不一致、実outbox更新、未commitの状態を混ぜない読み取り、group変更・論理削除後のsnapshot、物理削除制約、pagination・絞り込み、実repositoryを使うAPIを検証する。計測の再現は`pnpm exec vitest run --no-file-parallelism --silent=false apps/api/test/fleet-operation-results.integration.test.ts --reporter=verbose`を使う。

更新時はAPI/outboxを停止してmigrationを適用してから再開する。`0008_violet_ego.sql`でoutbox.updated_atをnullableとして追加し、既存行の本文・状態・試行回数を変えず、過去の未記録時刻を捏造しない。旧行ではcommandの既存時刻・published_atを使用し、以後のworker更新からupdated_atを記録する。MQTT topic・protocol・IoT Policyの変更や実AWSでの検証は行っていない。
