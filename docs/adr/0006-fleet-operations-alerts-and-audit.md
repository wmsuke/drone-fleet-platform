# ADR 0006: 複数機体操作の集約状態と運用記録

- 状態: 採用（設計のみ。DB、API、通信、画面は後続Issueで実装する）
- 決定日: 2026-10-13
- 対象: #135、#136、後続の#137〜#148

## 背景

現在は機体ごとのcommandとoutboxを保存し、受領ACKを追跡する。`ACKNOWLEDGED`は実行完了ではない。simulator内の`COMPLETED`や`UNCERTAIN`はSQLiteの記録であり、APIへ通知する経路はまだない。グループ操作で受領済みを成功と扱うと、帰還の完了や再起動後の復帰を誤って表示する。

Phase 4では既存の機体別commandを使い、対象の固定、受付の冪等性、結果の集約、alert、audit logを追加する。[ADR 0005](0005-delivery-and-recovery.md)の開始期限、重複実行防止、配送結果の不確定さは維持する。

## 決定

### エンティティと責務

以下は追加するモデルであり、現在のDB schemaではない。

| エンティティ                  | 関係・制約                                                                  | 責務                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `groups`                      | groupIdを主キーとし、削除は論理削除                                         | 名前、説明、構成変更用revisionを持つ                                                                         |
| `group_memberships`           | `(groupId, deviceId)`を一意にする。1機体は複数groupへ所属できる             | 現在の構成。過去の操作対象には使わない                                                                       |
| `fleet_operations`            | operationIdを主キー、`(idempotencyScope, idempotencyKey)`を一意にする       | groupId・名前・revision、command type、受付時刻、共通開始期限、actor、正規化した要求、結果確認期限を保存する |
| `fleet_operation_targets`     | `(operationId, deviceId)`を一意にし、commandIdも一意。1 operation対多target | 確定した対象を保存し、1 targetに1 commandを対応させる                                                        |
| `commands` / `command_outbox` | 既存の1対1。単一機体commandにはoperationがなくてよい                        | 送信と受領の状態、期限、実行結果を保存する正本。targetへ状態を二重書きしない                                 |
| `alerts`                      | 未解除の同一deduplication keyをDBで一意にする                               | 異常の発生・継続・解除と、確認済み状態を保存する                                                             |
| `audit_logs`                  | eventIdを主キーとするappend-only記録                                        | 操作と重要な状態遷移の事実を保存する。業務状態の正本にはしない                                               |

groupを論理削除してもoperationとtargetは消さない。operation、target、関連command、alert、auditはPhase 4では削除API・自動削除を設けない。参照するdeviceとcommandの物理削除を制約で拒否する。グループ名変更後も受付時の名前を表示できる。保持期限とアーカイブは別途設計する。

### 受付と対象スナップショット

APIの受付transactionでgroup行をロックし、削除状態、membership、対象数を確認する。membershipの追加・削除、group変更・削除も同じgroup行をロックしてrevisionを進める。全経路でこの規則を使い、受付と構成変更を直列化する。対象はこのロック取得後の構成で確定する。MQTT送信開始時に再取得しない。

operation、全target、対象ごとの異なるcommandId、outbox、成功auditを同じtransactionで保存し、commit後に202とoperationId・対象数を返す。1件でも作成できなければ全件rollbackする。存在しないgroupは404、空・削除済みgroupは409、不正要求・対象数上限超過は400で拒否する。対象数上限の初期値は100、設定で変更できるが、実測前に1,000台対応をうたわない。

OFFLINEの機体も対象へ含め、勝手に除外しない。既存outboxが期限内に再送する。期限は受付時刻から既存の30秒を全targetへ共通に設定し、末尾のtargetだけ延長しない。全件受付の原子性は、全機体で同時に操作することや全件成功を保証しない。commit後のmembership変更・機体の接続変化は対象を変更しない。

### APIの二重受付防止

グループ操作作成には`Idempotency-Key`を必須とし、1〜128文字のASCII英数字・ハイフン・アンダースコアを許可する。認証未実装時のscopeはサービス固定の`anonymous`。将来は検証済みprincipalからscopeを決め、クライアント指定actorをscopeに使わない。

正規化した要求はgroupIdとcommand type（将来追加する意味のある入力も含む）で比較する。同じscope・key・要求なら既存operationIdを返し、membership、期限、commandを作り直さない。元の受付結果を202で返し、現在の進行状況は詳細APIで取得する。同じkeyで要求が違う場合は409。既存keyの確認は現在のgroup存在・構成検証より先に行い、group削除後も受付済み要求を照合できるようにする。

同時要求はDB一意制約で競合を解決し、負けたtransactionをrollbackして既存要求を比較する。応答前にAPIが停止してもcommit済みなら同じoperationへ復帰する。rollbackした要求はkeyを消費しない。operationとkeyの対応は履歴とともに保持し、TTLで自動解放しない。keyは秘密情報ではないが、履歴の推測を避けるためUUIDなどの十分な乱数を推奨する。

### 受領と実行結果を分離する

既存`commands.status`の配送・受領状態は維持する。Phase 4では別項目`executionStatus`に`NOT_REPORTED`、`RUNNING`、`SUCCEEDED`、`FAILED`、`UNCERTAIN`を追加し、開始・結果の機体時刻とサーバー受信時刻を別に保存する。全targetに受付時点で結果確認期限を設定する。初期値は受付から120秒で、操作開始期限30秒とは別であり、開始許可を延長しない。

実行結果の通知は#139の前提作業として`packages/protocol`、simulator、ingestorを揃えて追加する。既存command-acks topic・QoS 1・retainなしを使い、ACK v3で受領、期限拒否に加えて`RUNNING`、`SUCCEEDED`、`FAILED`、`UNCERTAIN`を明示する。command v2と既存ACK v1/v2の読み取りは維持する。v2 ACKを完了通知へ読み替えず、未対応端末は結果未報告として扱う。新しいtopicやgroup共有topic、IoT Policyの権限拡張は不要とする。必須項目・検証・version互換の実装は#139で通信仕様に反映し、結果通知がないまま#140で成功集約を実装しない。

simulatorは結果と通知待ちをSQLiteへ永続化してから送る。再配送では同じcommandIdの保存済み最新結果を通知し、操作を繰り返さない。開始後停止は従来どおり`UNCERTAIN`とする。PUBACKはDB反映の証明ではなく、通知喪失時は結果未応答になり得る。結果確認期限による不明状態を残し、exactly-onceや結果通知の必達を保証しない。

`RETURN_HOME`の成功はsimulatorが帰還処理を終えて`IDLE`へ移ること、`REBOOT`の成功は予定した再起動処理とMQTT再接続・ONLINE通知の送信確認が終わることとする。単なる`RETURNING_HOME`への変更、受領ACK、telemetryや接続の変化だけから成功を推測しない。既存simulatorの動作をこの成功条件まで拡張する作業も#139で扱う。実機の着陸や物理的な安全を証明する定義ではない。

ingestorはdeviceId・commandId・schemaを検証し、知らないcommandや別機体の通知は拒否する。結果を受領より優先し、後着の受領・送信更新で実行結果を戻さない。重複する同一結果はno-op、異なる終端結果は衝突として記録し自動上書きしない。`UNCERTAIN`は確定結果ではなく自動再実行を禁止する状態とし、後着の確かな成功・失敗で解消できる。期限拒否と矛盾する実行結果も衝突として残す。

### targetと全体状態の集約

targetの表示状態はcommandの正本から以下の優先順位で導く。配送失敗は実行失敗と別の件数にする。

| 優先順位 | commandの根拠                                                 | targetの表示状態    | 集約上の分類                           |
| -------- | ------------------------------------------------------------- | ------------------- | -------------------------------------- |
| 1        | 実行結果`SUCCEEDED`                                           | `SUCCEEDED`（完了） | 成功                                   |
| 2        | 実行結果`FAILED`                                              | `EXECUTION_FAILED`  | 不成功・実行失敗                       |
| 3        | 実行結果`UNCERTAIN`                                           | `UNCERTAIN`         | 不成功・結果不明                       |
| 4        | 配送状態`EXPIRED`                                             | `EXPIRED`           | 不成功・開始期限切れ                   |
| 5        | 配送状態`FAILED`                                              | `DELIVERY_FAILED`   | 不成功・送信失敗。未実行の証明ではない |
| 6        | 配送状態`TIMED_OUT`、または結果確認期限に達して終端結果がない | `UNRESPONSIVE`      | 不成功・受領または結果未応答           |
| 7        | 実行結果`RUNNING`                                             | `RUNNING`           | 進行中                                 |
| 8        | 配送状態`ACKNOWLEDGED`                                        | `ACKNOWLEDGED`      | 受領済み・結果待ち                     |
| 9        | 配送状態`SENT`                                                | `SENT`              | 送信確認済み・受領待ち                 |
| 10       | 配送状態`PENDING`                                             | `PENDING`           | 送信待ち                               |

`EXPIRED`を「過去に一度も実行していない」と説明しない。受付拒否はoperationを作らないためtargetに含めない。結果通知対応前の既存commandには成功を補完しない。

全体状態は同一DB snapshotと同一評価時刻で算出する。総target数、各表示状態の件数、成功・不成功・進行中件数を返し、合計は総数に一致させる。受領時刻を持つ件数は別指標であり、状態別の合計には加えない。

| 条件                                        | operationの状態                  |
| ------------------------------------------- | -------------------------------- |
| 全targetが`PENDING`で、期限超過なし         | `ACCEPTED`（受付）               |
| 進行中分類が1件以上あり、上記以外           | `IN_PROGRESS`（進行中）          |
| 全targetが成功                              | `COMPLETED`（全件完了）          |
| 進行中が0、成功が1件以上かつ不成功も1件以上 | `PARTIALLY_FAILED`（一部不成功） |
| 進行中が0、成功が0                          | `FAILED`（全件不成功）           |

例: 2台成功・1台受領待ちは`IN_PROGRESS`、待機機体が未応答になれば`PARTIALLY_FAILED`。全台受領済みでも結果未報告なら`COMPLETED`ではなく、結果確認期限までは進行中、以後は未応答として全件不成功になる。不成功は配送や結果確認を完了できなかった意味を含み、全機体の操作失敗とは断定しない。

ACK・結果の遅着で未応答や送信失敗が解消された場合は再集約する。結果確認期限後の`RUNNING`・受領だけでは未応答を解消しない。後着の成功・失敗は反映し、たとえば`PARTIALLY_FAILED`から`COMPLETED`へ変わり得る。期限超過時刻・過去の失敗・集約状態変更は履歴とauditに残し、最初の確認終了時刻を消さない。終端表示は通信を打ち切った評価であり、不変の結果ではない。

全体状態はtargetとcommandからAPIで集約し、ACK処理がoperationを直接更新する方式は採用しない。期限の評価は読み取り時にも行い、workerの遅延で永久に進行中にしない。一覧の集計と対象一覧は一括query・paginationで取得し、N+1を避ける。

### 同時実行、キャンセル、再実行

異なるoperationは同時受付でき、groupが重複していても拒否しない。異なるkeyの操作は別commandとなり、機体間の同時開始や同一機体のcommand順序は保証しない。画面に未終端commandの存在と再起動による切断リスクを表示し、操作者が確認する。排他スケジューラや予約実行はPhase 4に含めない。

受付transactionのrollback以外のキャンセルAPIは設けない。commit後は一部が既に機体へ到達し得るため、安全に全件撤回できない。outboxの再送は同じcommandの配送試行であり、新しい操作ではない。再実行は人が結果を確認して新しいkeyで新しいoperationを作る。元operationとcommandを上書きしない。失敗対象だけの自動再実行・選択再実行、補償操作、二相commit、全機体同時実行は対象外とする。

### alertの初期条件

alert evaluatorはDB確定済みの事実を周期的に評価し、MQTT保存transactionから分離する。初期評価間隔は5秒。閾値・継続時間は設定可能とし、設定値またはrule versionをalertへ記録する。DBに条件成立開始時刻、最終評価した観測識別子、回復開始時刻を保存し、再起動しても継続時間をリセットしない。複数evaluatorは対象キーをロックし、未解除一意制約と合わせて重複発生を防ぐ。

| 条件・初期severity     | 発生条件                                                                                | 継続・解除条件                                                                                                                          | 重複抑制key                    |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 長時間OFFLINE・warning | 既存のliveness規則でOFFLINEに遷移し、その状態が60秒以上続く                             | 新しい有効受信でONLINEに戻り30秒継続したら解除。retained status・旧再送だけでは解除しない                                               | `(deviceId, OFFLINE)`          |
| 低battery・warning     | 新鮮なtelemetryでbatteryが20%以下の状態が30秒以上続く                                   | 25%以上が30秒継続したら解除。20%超25%未満では現在の状態を維持する                                                                       | `(deviceId, LOW_BATTERY)`      |
| command不成功・warning | targetの実行失敗、送信失敗、開始期限切れ、未応答、結果不明。単一commandも同じ規則で評価 | 失敗・期限切れは自動解除せず確認後も残す。未応答・送信失敗・結果不明は後着の確かな成功で解除し、確かな失敗なら同じalertの根拠を更新する | `(commandId, COMMAND_OUTCOME)` |

既存deviceの最終受信時刻から単に60秒を測るのではなく、OFFLINE遷移開始を永続化する。ONLINEの継続中に再びOFFLINEなら回復タイマーを取り消す。

batteryの新鮮さはdevice timestampが評価時刻から過去15秒以内・未来5秒以内で、受信も過去15秒以内であることとする。同一sessionの既評価sequence以下、重複、retained、device timestampが既採用値以前のサンプルを評価へ再利用しない。session変更でもdevice timestampの単調性を確認する。APIの受信順「最新telemetry」をそのまま使うと旧buffer再送で誤解除するため、alert用の採用観測を別に管理する。欠測・OFFLINE時にはbattery alertを解除せず、継続・回復タイマーを中断する。再開後は連続した新鮮な観測で改めて30秒を測る。5秒を超える観測の空白ではタイマーを中断し、欠測を低batteryの証明にしない。端末時計が信用できない場合も新鮮と扱わない。

alertは`ACTIVE` / `RESOLVED`と確認情報`acknowledgedAt`・actorを別に持つ。確認は解除や異常の回復ではない。未解除の同じkeyは発生時刻を保ち、最終観測時刻・根拠を更新する。解除後に条件が再成立したら新しいalertを作り、履歴を残す。command alertは同じcommandが同じ原因で評価され続ける限り再発させない。新しいcommandの失敗は別alertである。

evaluator失敗はtelemetry保存やACK更新をrollbackさせない。未評価分をDBから再走査し、発生・更新・解除と評価checkpointを同じtransactionで確定する。評価件数、発生、更新、解除、失敗、評価遅延を計測する。audit追記に失敗した場合もその評価transactionをrollbackして再試行する。温度、位置、飛行安全、容量予測、メール・外部通知、自動commandは初期対象外とする。

### audit logと信頼境界

記録項目はeventId、サーバーUTC時刻、actor種別（`anonymous` / `system`、将来の`authenticated`）、actorId、action、target種別とID、result（`SUCCEEDED` / `REJECTED` / `FAILED`）、requestId、groupId・operationId・commandId・alertId、許可したmetadata、記録schema versionとする。actionの成功はその操作のcommitを示し、commandの実行成功とは区別する。

| 対象                                             | 成功の記録境界                                                            | 拒否・失敗の扱い                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| group作成・変更・論理削除、membership追加・削除  | 業務変更とauditを同一transactionでcommit                                  | 拒否理由コードと変更なしを別transactionで記録                                                                  |
| 単一・複数command受付                            | command・outbox・operation・targetと受付auditを同一transactionでcommit    | 不正要求、空group、上限、key不一致等を記録。冪等再要求は再受付成功を作らず`operation.replayed`として元IDを記録 |
| alert確認                                        | 確認情報とauditを同一transactionでcommit                                  | 存在しない対象や不正要求を記録                                                                                 |
| command受領・期限拒否・実行結果、alert発生・解除 | 正本の変更とsystem auditを同一transactionでcommit                         | 同一通知の再処理は追記しない。衝突は理由コードを記録                                                           |
| operationの集約状態変更                          | evaluatorが前回集約と比較し、状態変更記録とauditを同一transactionでcommit | 同じ集約の再評価は追記しない。API読み取りはこのcheckpointに依存せず現在状態を算出する                          |

metadataには変更前後のgroup名・membership差分、command type、対象件数、状態変更前後、理由コードを許可する。raw request、認証header、証明書、秘密鍵、telemetry本文、任意の例外全文を保存しない。サイズ上限を設け、拒否された入力は検証済みの識別子と理由だけ残す。読み取り・healthcheckは初期記録対象外とする。

成功auditの保存に失敗したら業務transactionもrollbackし、成功を返さない。拒否・失敗auditは業務rollback後に別transactionで試行する。DB自体の停止・応答前のプロセス停止では拒否・失敗記録が欠落し得る。安全なサーバーログと失敗メトリクスを残すが、ログを必達auditとは呼ばない。無制限リトライや別の永続キューは追加しない。

認証未実装時のactorIdはnull、HTTP操作のactor種別は`anonymous`、内部処理は固定のsystem識別子とする。クライアント申告の名前・headerを検証済み操作者として扱わない。requestIdは追跡用で本人確認の代わりではなく、UIは「操作者未認証」と表示する。認証が入るまでは「誰が」を保証できないため、APIはローカルまたは制限したネットワークで使う。

アプリケーションのaudit repositoryはINSERT / SELECTのみ公開し、更新・削除APIを設けない。migrationでUPDATE / DELETE拒否のDB triggerを付け、通常の実行roleで無効化・DDLできないよう運用を分離する。DB ownerや管理者はtriggerの無効化や直接改変が可能である。Phase 4では署名、hash chain、WORM、外部保管を追加せず、管理者改ざんを検出・防止する保証はしない。

## 理由とトレードオフ

- group共有topicの一括publishは件数を減らせるが、機体ごとの期限・再送・結果追跡を壊す。既存command/outboxを機体ごとに作る方式を採用する。
- membershipの都度参照よりスナップショットは保存量が増えるが、過去の対象と操作を再現できる。group行のロックで変更との境界を明確にする。
- 受領ACKだけで成功集約する案は実装が小さいが、親Issueの完了追跡を満たさない。明示的な実行結果通知を追加し、未対応・結果喪失を不明のまま表示する。
- 読み取り時の集約はDB負荷があるが、ACKとoperationの二重更新不整合を避ける。計測後に必要なら集約キャッシュを別途検討する。
- 同時操作の排他・キャンセルは安全な撤回や端末の仲裁が必要になる。Phase 4では制約を表示し、結果不明の自動再実行を避ける。
- alertは保存処理と分離し、検知に評価間隔分の遅延を許容する。telemetryの耐久性を優先し、重複抑制・新鮮さ・回復条件をDBで再現できるようにする。
- 成功auditの同時commitは受付可用性を下げるが、成功した重要操作の記録欠落を防ぐ。本人確認と管理者への改ざん耐性は別の課題として残す。

## 後続Issueと検証

| Issue      | この判断を実装・検証する範囲                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| #137〜#138 | groupとmembership、変更ロック・revision・論理削除、画面                                                                            |
| #139       | 原子的な受付、対象上限、同時idempotency要求、構成変更との競合。ACK v3、simulatorの完了条件・永続結果通知、ingestorの正本保存を含む |
| #140〜#141 | target・全体の状態表、期限境界・遅着・結果衝突・件数整合、N+1回避と画面表示                                                        |
| #142〜#143 | alert閾値・hysteresis・欠測・旧session再送・重複・再起動・確認と解除の分離                                                         |
| #144〜#145 | auditの同時commit、rollback、拒否記録失敗、重複通知、DB更新拒否と検索・画面                                                        |
| #146〜#148 | 100台を起点に受付時間・query数・DB負荷・結果到達時間を実測し、E2Eと文書へ反映                                                      |

このIssueでは設計文書のみ変更する。新しいschema、ACK、API、alert、auditが動作するとは記載しない。後続Issueでは単一機体API、v1/v2の既存履歴、local/AWS経路への回帰も検証する。AWSでの検証は#64の費用・短時間試験の境界を守り、継続負荷はローカルで行う。

## 参照

- [システム構成](../architecture.md)
- [通信仕様](../protocol.md)
- [ロードマップ](../roadmap.md)
- [コマンドの期限と永続化](../command-durability.md)
