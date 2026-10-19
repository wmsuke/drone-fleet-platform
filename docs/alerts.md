# alertの生成と解除

#142で長時間OFFLINE、低battery、command不成功を評価する`apps/alert-evaluator`を追加した。MQTTを購読せず、commit済みのPostgreSQLの事実だけを読む。#143で一覧・詳細API、画面と確認操作を追加した。audit logとの同時記録は#144で追加する。現時点では監査記録の保証や外部通知を提供しない。

## 初期条件

初期severityはすべてwarning。未解除の同じdeduplication keyは一つに制限する。

| 種別 | 発生 | 自動解除 | key |
| --- | --- | --- | --- |
| OFFLINE | 既存livenessでOFFLINEへ遷移してから60秒 | 新しい有効な受信でONLINEが30秒継続 | deviceId + OFFLINE |
| LOW_BATTERY | 新鮮なtelemetryが20%以下で30秒継続 | 25%以上の新鮮なtelemetryが30秒継続 | deviceId + LOW_BATTERY |
| COMMAND_OUTCOME | 実行失敗、送信失敗、開始期限切れ、未応答、結果不明 | 送信失敗・未応答・結果不明は後着の確かなSUCCEEDEDで解除。実行失敗・期限切れは自動解除しない | commandId |

20%超25%未満では発生・解除の継続タイマーを中断し、既存alertの状態は維持する。OFFLINEや欠測時もbattery alertを勝手に解除しない。

commandの判定は[ADR 0006](adr/0006-fleet-operations-alerts-and-audit.md)のtarget優先順位に従う。期限前は有効なRUNNINGや受領記録が配送FAILED/TIMED_OUTより優先する。期限後の受領やRUNNINGだけでは未応答を解消せず、受領を成功と扱わない。group操作は保存済みresultDeadline、単一commandは作成から既定120秒で結果未応答を評価する。開始期限を延ばすものではない。

既に送信失敗・未応答のalertがあれば、後着の受領やRUNNINGで進行中へ戻っても解除しない。確かな成功まで残す。UNCERTAINから確かな実行失敗になった場合は同じalertの根拠を更新する。ingestorで衝突とされた結果は正本へ適用されず、解除の根拠にもならない。同じcommandは解除後も再発行しない。新しいcommandの不成功は別alertである。

## 観測と継続時間

- batteryとONLINE回復の証拠は、端末時刻が評価時刻の過去15秒〜未来5秒、受信も過去15秒以内にある観測に限る。
- retained telemetryは採用しない。retained ONLINEは従来どおりlivenessも更新せず、回復用観測を作らない。非retained ONLINEは端末時刻ごとに最初の受信を保存する。
- v2 telemetryの重複・衝突は既存保存経路で除外する。評価側でもsessionごとの採用sequenceと端末時刻の単調性を保持し、同じsequence以下や端末時刻が戻る観測を再採用しない。sessionが変わっても端末時刻は戻さない。v1は単一legacy session扱いで、再起動によるsequence戻りの回復は保守的に扱う。
- 連続する観測は端末時刻差・DB受信時刻差の両方が正で既定15秒以下であることを要求する。15.001秒のgapは中断し、次の有効観測から測り直す。受信時刻が戻る・同値になる新しい観測では継続を中断し、採用時刻を巻き戻さない。
- 継続時間は最初と最後の採用観測のDB受信時刻差で測る。evaluatorの時計だけでbattery発生や回復を進めない。新しい採用観測なしに許容gapを超えた場合、継続・回復タイマーを中断する。端末時計の未来ずれが許容を超える場合も中断する。
- deviceのconnectionChangedAt・connectionRevisionを接続状態変更と同じtransactionで保存する。OFFLINE開始は最終受信時刻で代用せず、実際に状態を変えた時刻を使う。評価の間に短いOFFLINEとONLINEがあった場合もrevision変化で継続を中断する。現在の接続遷移より前の観測は回復へ使わない。

直近15秒の候補をDB受信順に再走査し、評価済み観測識別子、採用時刻、sessionごとのsequence、継続・回復開始をcheckpointへ保存する。serial IDだけのhigh-water markは使わず、遅れてcommitした低いIDを取りこぼさない。古いbuffer再送は履歴として保存されても、alertの継続や解除を延長しない。evaluator停止中に鮮度・gap条件を失えば継続を再開せず測り直す。

## 保存と失敗境界

alertsはalertId、deviceId、必要なcommandId、kind、status、severity、reason、発生・最終観測・解除時刻、ruleVersion、判定に適用したparametersと限定したevidenceを持つ。ACTIVEとRESOLVEDを分け、acknowledgedAt・actor項目は確認情報として別に持つ。

## 一覧・詳細・確認APIと画面

- `GET /alerts`は`{ items, total, limit, offset }`を返す。`status=ACTIVE|RESOLVED`、`severity=warning`、`kind=OFFLINE|LOW_BATTERY|COMMAND_OUTCOME`、`acknowledged=true|false`、`deviceId`、`groupId`、`operationId`、`from`、`to`で絞り込む。条件はAND、期間は発生時刻の両端を含み、UTCのISO 8601で指定する。
- `limit`は1〜100（既定20）、`offset`は0〜1,000,000（既定0）。発生時刻降順、同値はalertId降順。件数・ページ・関連情報は同一DB snapshotで読む。ページ間は独立したsnapshotなので、継続中の新規発生でoffsetの位置は変わり得る。
- `GET /alerts/:alertId`は詳細を返す。保存した根拠・設定に加え、`relatedGroups: [{ groupId, name }]`と`operationId`を含む。機体状態alertのgroupは現在の未削除groupの所属、command alertのgroupは操作開始時のsnapshotに基づく。所属変更・名称変更・削除でcommandの過去の関連を置き換えない。単一commandにgroup操作の関連はない。削除済みgroupへのリンクは404になり得るが、alertには開始時の名称とIDが残る。
- `POST /alerts/:alertId/acknowledge`はbodyなし（または空object）で最初の確認時刻をDB時計から保存し、詳細を返す。繰り返し・同時要求でも最初の確認時刻を保つ。任意のactor指定は拒否する。不存在は404、不正なID・条件・bodyは400。

確認操作はstatus・根拠・解除時刻を変えない。確認後もACTIVEのまま残る場合があり、自動解除は確認状態を消さない。認証未実装のため`acknowledgedActorKind=anonymous`、`acknowledgedActorId=null`であり、実在の運用者を識別・証明する記録ではない。画面にも「匿名（本人性未確認）」と制約を表示する。公開インターネットへ認証なしで公開しない。権限制御と成功auditの同時記録は未実装。

dashboardの`/alerts`で件数、severity、発生時刻、解除状態と確認状態を表示する。20件ずつページングし、条件はURLに保持する。詳細は`/alerts/:alertId`。機体・group・操作の詳細から絞り込んだalertへ、alertから関連する詳細へ移動できる。一覧・詳細は5秒ごとに更新し、更新失敗時は前回の結果であることを明示する。空一覧、初回取得失敗、確認保存失敗と再試行を区別する。見出しへのfocus、ラベル付き条件入力、表caption・列見出し、キーボードで操作できるページ送りを設ける。

`pnpm check`でAPI入力とUIのページング・空一覧・失敗・定期更新・確認状態の分離を検証する。`DATABASE_INTEGRATION=true pnpm api:test:integration`では実PostgreSQLで35件のページングと条件、過去の操作group、並行確認、解除後の確認記録保持を確認する。

2026-10-19、専用Compose（仮想機体3台、架空alert 25件）と実ブラウザで、20件＋5件のページング、Enterキーでの操作、遷移後の見出しfocus、匿名での確認保存を確認した。確認しても「発生中」のまま残ることを[画面例](dashboard-alert-detail.jpg)に示す。スクリーンリーダー実機や全ブラウザの網羅検証ではない。

未解除keyの部分一意indexとtargetごとのtransaction advisory lockで二重作成を防ぐ。device/commandの正本を読み取りロックし、alertとcheckpointを同じtransactionでcommitする。失敗時は両方rollbackし、次回再走査する。既にcommitしたtelemetry・ACKはrollbackしない。観測属性の記録は元の受信transactionに含むが、alert判定・生成をそのtransactionから呼ばない。

同じ条件が続けばalertIdと発生時刻を保ち、最終観測・根拠を更新する。解除後にdevice条件が再成立すれば新しいalertを保存する。commandには全履歴で一意制約も設け、同じcommandを繰り返し発報しない。同じ観測を同じ評価時刻で再処理しても追加・解除を重ねない。サーバー評価時刻がcheckpointより戻った場合は、そのtargetを更新せず時計が追い付くのを待つ。

設定・rule version変更時は継続checkpointを再初期化し、旧設定の継続時間を新条件へ引き継がない。既存alertは自動削除せず、以降に適用する設定をparametersへ記録する。状態変更auditや管理者改ざんへの耐性は未実装である。

複数evaluatorは同じ設定・rule versionで動かす。設定を変える際は全evaluatorを停止して揃えて再開し、異なる設定のプロセスで同じcheckpointを交互に初期化しない。

## 起動・設定・計測

通常の`docker compose up --build -d`でmigrate成功後に独立したalert-evaluatorが起動する。MQTT/APIのポートは追加しない。個別起動は`docker compose up --build -d postgres migrate alert-evaluator`を使う。停止時は進行中のtransactionを待ってDB接続を閉じる。

| 環境変数 | 既定値 |
| --- | ---: |
| ALERT_EVALUATION_INTERVAL_MS | 5000 |
| ALERT_OFFLINE_HOLD_MS | 60000 |
| ALERT_RECOVERY_HOLD_MS | 30000 |
| ALERT_BATTERY_HOLD_MS | 30000 |
| ALERT_LOW_BATTERY | 20 |
| ALERT_RECOVERED_BATTERY | 25 |
| ALERT_OBSERVATION_GAP_MS | 15000 |
| ALERT_COMMAND_RESULT_MS | 120000 |

時間は正の整数、batteryは0〜100の整数で回復値が低下値より大きいことを要求する。gapはTELEMETRY_INTERVAL_MS（既定5000）より大きく15秒以下、評価間隔以上とする。不正設定では起動しない。鮮度15秒・未来ずれ5秒はrule v1の固定条件としてparametersに保存する。

各周期にJSONの`alert.evaluation`を出す。evaluatedは成功したtarget評価数、created/updated/resolvedはcommit結果、failedは評価失敗数、durationMsは周期全体の時間、evaluationLagMsは予定した次周期に対する開始遅延である。生の例外・MQTT本文・認証情報はログへ出さない。件数はプロセス内の周期計測であり、永続的な監査カウンターではない。複数プロセスの合算をalert総数と読み替えない。

更新時は保存サービスを止め、`0009_glossy_master_mold.sql`を適用してから新しい保存サービスとevaluatorを起動する。既存deviceの接続遷移履歴は不明なのでmigration時点を初期基準とし、過去のOFFLINE継続を捏造しない。旧telemetryのretained属性も不明なので安全側のtrueとして既存行を保持し、新しい非retained観測から採用する。

alerts、ONLINE観測、評価checkpointに自動削除は設けない。観測のseen集合は鮮度窓で整理するが、session別sequenceは保存し続ける。DB容量と長期運用時のcheckpointサイズを監視し、保持・archiveは別途設計する。候補は機体ごと・commandごとに短いtransactionで評価する。大量機体・大量command履歴の性能はこの実装で保証しない。

## 検証と対象外

`pnpm check`で境界・時間・hysteresis・再処理・worker停止を検証する。専用PostgreSQLを指定し`DATABASE_INTEGRATION=true pnpm alerts:test:integration`で同時評価、再起動、遅延/retained/重複、短い通信断、実行結果の遅着・衝突、期限、設定変更、一意制約、失敗時のalert/checkpoint同時rollbackと保存済みtelemetry/ACKの維持を確認する。既存のDB・telemetry・API結合テストも維持する。

2026-10-19、Node.js 24.21.0 / pnpm 10.28.1 / OrbStack / PostgreSQL 17でalert結合15件、既存telemetry結合24件、API結合52件、DB移行3件を確認した。専用ComposeのNode.js 22では、確認用に周期100ms・OFFLINE継続1000msへ短縮して独立workerを起動し、生成と再起動後の同一alertId・発生時刻の保持、failed=0の周期ログを確認した。defaultの時間境界は偽時計を使う単体・DB結合テストで評価しており、短縮した起動確認を60秒の実時間計測とは扱わない。

温度、位置、物理的な飛行安全、容量予測、メール等の外部通知、自動command、auditは対象外。AWSの実通信・100台のalert性能は未検証であり、ローカルでの検証をAWS運用の保証としない。
