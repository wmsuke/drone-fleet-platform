# 操作と状態変更のaudit log

#144でappend-onlyな`audit_logs`と、重要な操作・状態遷移の記録を追加した。#145で[検索APIと閲覧画面](audit-log-search.md)を追加した。auditを業務状態の正本や、本人確認の証拠にはしない。

## 保存項目

eventId（UUID）、schemaVersion（1）、occurredAt（DBの`clock_timestamp()`）、actorKind、actorId、action、targetKind・targetId、result、requestId、groupId・operationId・commandId・alertId、metadataを保存する。時刻はUTCで扱う。時刻だけで全transactionのcommit順序を断定しない。

resultは`SUCCEEDED`（その保存操作がcommitされた）、`REJECTED`（入力や業務条件で拒否）、`FAILED`（HTTP処理失敗）である。`command.accepted`の成功は機体の実行完了ではない。`command.expired`のSUCCEEDEDは期限拒否の保存成功であり、操作成功ではない。

requestId、operationId、commandId、targetKind・targetId、発生時刻にindexを設けた。auditの関連IDには外部キーを付けず、不存在への拒否や対象削除後も記録を残す。自動削除や更新・削除APIは設けない。

## 対象とtransaction境界

| action | 保存境界・重複の扱い |
| --- | --- |
| group.created / updated / deleted | groupの作成・変更・論理削除と同じtransaction。更新では変更前後の名前を記録する |
| membership.added / removed | membershipとgroup revisionの更新と同じtransaction。差分のdeviceIdを記録する |
| command.accepted | 単一command・outboxと同じtransaction。複数操作では各commandにoperationIdとgroupIdも付け、一括INSERTする |
| operation.accepted | operation・固定target・command・outbox・初期集約checkpointと同じtransaction |
| operation.replayed | 同じscope/key/要求で既存operationを返すtransaction。受付成功やcommandを再作成しない |
| alert.acknowledged | 最初の確認情報と同じtransaction。同時要求・再試行は最初の1件だけ記録する。解除とは独立する |
| command.acknowledged / expired / execution_changed | ingestorがcommand正本と通知イベントを保存するtransaction。受領・期限拒否・実行状態は別actionで残す |
| command.conflict | 初めて保存する衝突通知イベントと同じtransaction。正本は変えず、REJECTEDと理由を記録する |
| alert.raised / resolved / reason_changed | alertと評価checkpointと同じtransaction。継続中の観測時刻更新だけではauditを増やさない |
| operation.status_changed | 周期評価のcheckpointと同じtransaction。前回と同じ集約状態は追記しない |

成功auditのINSERTに失敗すると業務変更もrollbackし、HTTP成功を返さない。複数commandの1件でもauditを保存できなければ全受付を戻す。alertの評価失敗は既にcommit済みのtelemetryやACKを戻さず、次の周期で再試行する。ACKのaudit失敗では正本と通知イベントを戻すため、同じ通知の再配送を新しく処理できる。結果通知の必達保証を追加するものではない。

同一ACK・実行結果・衝突の再通知は既存の重複判定に従い追記しない。後着の受領や確定結果で正本を変える場合は別の遷移として残す。command由来のauditは固定済みtargetからoperationId・groupIdを引き、現在のmembershipで過去の関連を置き換えない。

## HTTPの拒否・失敗

本番APIの対象POST / PATCH / DELETEに対する400以上の応答は、業務transactionの終了後、別のINSERTで記録を試みる。入力不正、対象不存在、空group、削除group、対象上限、idempotency不一致などが対象。安全に検証できたID、statusCodeと固定の理由コードだけを残し、要求本文や例外を写さない。失敗したHTTP応答でも、応答生成前に既に業務commitしていた場合は成功auditも残り得る。HTTP失敗だけを「変更なし」の証明にしない。

拒否・失敗auditの保存に失敗しても元のHTTPエラーを維持する。DB停止やプロセス停止ではこの記録が欠落し得る。必達キューや無制限リトライは追加しない。`audit.transaction_write_failed`にプロセス内の累積failures、固定actionとserver requestId、`audit.write_failed`に拒否・失敗記録の累積failuresを出す。SQL・例外全文・認証情報はこのログに含めない。これらは障害検知用であり、永続auditではない。

HTTP API以外からrepositoryを直接呼ぶテスト・内部処理にも成功auditは付くが、HTTP拒否hookは実行されず、requestIdはnullとなる。読み取り・healthcheck、未定義route、MQTTのschema不正・未知command、通常のtelemetry保存、outboxの配送試行そのものはaudit対象外。未知の通知は既存の安全な診断ログで扱う。

## 集約状態の記録

既存`alert-evaluator`プロセス内で、独立したoperation audit workerも起動する。周期は`ALERT_EVALUATION_INTERVAL_MS`（既定5秒）を使う。APIと共有するSQLで同じ優先順位・期限規則を評価し、operationごとのtransaction advisory lockで複数workerを直列化する。APIのGETはcheckpointに依存せず、その時点の正本から状態を返す。

`operation_audit_states`に最後に観測したstatus、evaluatedAt、firstFinishedAtを保存する。firstFinishedAtは初めてCOMPLETED / PARTIALLY_FAILED / FAILEDを**観測した評価時刻**であり、機体の完了時刻や期限到達時刻そのものではない。後着成功や再起動で消さない。評価時計が前回より戻った場合は更新しない。

移行前のoperationは初回評価で現在の状態をbaselineとして記録する。過去の中間状態や完了時刻は捏造しない。周期の間に通過した中間状態はauditに残らない場合がある。command通知のauditと合わせて調べる。毎周期`operation.audit_evaluation`にevaluated / changed / failedを出す。全履歴を評価する初期実装なので、大量履歴や長期保持の性能保証はない。

## 認証・秘密情報・改ざん耐性

HTTPのactorKindはanonymous、actorIdはnull。requestIdはサーバーでUUIDを生成し、`X-Request-Id`応答headerに返す。クライアントのactor・request-id headerは採用しない。requestIdは追跡用で本人確認ではない。内部処理のactorKindはsystem、actorIdはtelemetry-ingestor / alert-evaluator / operation-evaluator / ota-workerの固定識別子で、端末操作者や物理的な実行の正当性を証明しない。#171の`deployment.approved` / `deployment.stopped` / `deployment.resumed`は理由付き操作と同時保存し、自動停止はota-workerとして区別する。

metadataは変更前後のgroup名、descriptionの変更有無、差分のdeviceId、command type、対象件数、状態・理由コード、statusCodeだけを許可し、helperで未知のkeyを拒否する。DBでもobjectと8KiB上限を要求する。description本文、HTTP本文・header、IP、user-agent、idempotency key、証明書・秘密鍵、telemetry本文・位置、任意の例外全文は保存しない。group名自体に秘密情報や個人情報を入れない。

migration `0010_early_salo.sql`でUPDATE / DELETE / TRUNCATEを拒否するstatement triggerを追加する。アプリケーションのhelperはINSERTのみであり、変更・削除APIはない。DB ownerや管理者はtriggerを無効化・削除できる。署名、hash chain、WORM、外部保管は追加しておらず、管理者改ざんを検出・防止できない。

既定のローカルComposeはmigrationと実行で同じDB ownerを使う。これはDDL権限の分離を保証しない。運用環境ではmigration ownerとログインする実行roleを分け、実行roleをtable owner・superuser・migration roleのmemberにしない。既存の業務table・sequenceへの必要権限に加え、auditにはINSERT / SELECTだけを付ける。以下はDB管理者が既存の実行roleへ適用する例であり、自動実行はしない。

```sql
GRANT USAGE ON SCHEMA public TO fleet_runtime;
GRANT INSERT, SELECT ON audit_logs TO fleet_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM fleet_runtime;
```

認証・権限制御が入るまではローカルまたは制限したネットワークで使う。拒否auditも増えるので、保持容量と接続元の制限を運用で監視する。

## 確認方法と移行

書き込みサービス（API、ingestor、evaluator）を停止し、migrationを適用して揃えて再開する。過去の操作をauditへ補完しない。通常のCompose起動では既存のmigrate完了後に各サービスが起動する。

通常の追跡には[検索APIと閲覧画面](audit-log-search.md)を使う。DB管理者はUUIDをパラメータにして次のようにも追跡できる。直接SQLはAPIの公開項目制限を通らないため、metadataを含む結果を外部共有する前に内容を確認する。

```sql
SELECT event_id, occurred_at, actor_kind, actor_id, action, result,
       request_id, operation_id, command_id, target_kind, target_id, metadata
FROM audit_logs
WHERE operation_id = $1::uuid
ORDER BY occurred_at, event_id;
-- request_id = $1::uuid、command_id = $1::uuidでも追跡できる。
```

`pnpm check`に加え、専用PostgreSQLで`DATABASE_INTEGRATION=true pnpm api:test:integration`と`DATABASE_INTEGRATION=true pnpm alerts:test:integration`を実行する。成功・拒否・失敗、同時確認、replay、許可外metadata、audit INSERT障害時の業務rollback、ACK・衝突の重複、集約の期限・遅着・再起動、初回終了時刻保持、append-onlyと非owner roleのDDL拒否を検証する。DB移行・既存telemetry結合テストも維持する。

2026-10-19、Node.js 24.21.0 / pnpm 10.28.1 / OrbStack / PostgreSQL 17の専用DBで、DB移行3件、API結合62件（既存の条件付き1件skip）、telemetry結合24件、alert・system audit結合21件を確認した。通常チェックは673件成功、DB等の条件付き112件skip。専用ComposeのNode.js 22・仮想2台でもHTTP受付→MQTT→両台SUCCEEDEDを確認し、同じoperationIdに受付1件・command受付2件・受領2件・RUNNING/SUCCEEDED計4件・集約変更2件が残った。受付のserver requestIdにはoperationと2 commandの3記録が関連付いた。集約checkpointはCOMPLETEDとfirstFinishedAtを保持し、workerのfailedは0だった。実AWS・100台の継続負荷は実施していない。
