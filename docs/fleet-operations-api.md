# グループ操作の受付API

#139でgroupの現在の構成を固定し、対象ごとのcommand/outboxを作る受付APIを追加した。実行結果通知は#152、一覧・詳細と結果集約は#140、操作画面は#141で実装する。受領ACKを完了結果へ読み替えない。

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

`ACCEPTED`はDBへの受付成功であり、送信・受領・操作完了ではない。同じ要求の再送も元の受付結果を202で返す。現在の進行状況を示す応答ではない。対象のcommandは既存の機体別履歴APIで確認できる。operation一覧・詳細・集約APIは未実装である。

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

`FLEET_OPERATION_MAX_TARGETS`は既定100、設定範囲1〜1000。上限+1件までmembershipを取得して超過を判定する。1000は設定上限であり性能保証ではない。起動時に不正設定を拒否する。成功時のログにtargetCount、transaction完了までのdurationMs、replayedを出す。認証情報・要求本文・keyは計測ログに出さない。audit logとの同時commitは#144で追加する予定で、現時点で監査記録の保証はない。

## 検証と実測

2026-10-14、macOS / Apple M2 / arm64 / memory 17179869184 bytes、Node.js 24.21.0、pnpm 10.28.1、OrbStack、PostgreSQL 17.11で実施した。専用DB・localhost:55439を使用し、MQTT workerを起動せず全100台をOFFLINEとして受付を計測した。

| 回 | 対象数 | 受付時間（ms） | Drizzle query数 |
| --- | ---: | ---: | ---: |
| 1 | 100 | 21.563 | 8 |
| 2 | 100 | 20.505 | 8 |
| 3 | 100 | 24.808 | 8 |

新規keyで3回実行した。時間はrepository呼び出しからtransaction commitを含む応答生成まで。query数はDrizzle loggerによる実測で、lock、照合、group取得、membership取得、4つのINSERTを数える。postgres.jsのBEGIN / COMMIT、接続準備、fixture・cleanupはquery数に含めない。HTTP転送、MQTT配送、受領、実行完了、1,000台負荷を測ったものではない。

再現には専用PostgreSQLの`POSTGRES_*`と`DATABASE_INTEGRATION=true`を設定して`pnpm api:test:integration`を実行する。実測値を表示する場合は`pnpm exec vitest run --no-file-parallelism --silent=false apps/api/test/fleet-operation-repository.integration.test.ts --reporter=verbose`を使う。テストでは同時再要求、要求不一致、構成変更競合、group削除後の再要求、途中保存失敗・全件rollback、上限と既存単一device受付も確認する。migrationは`pnpm db:test:integration`で既存経路も検証する。
