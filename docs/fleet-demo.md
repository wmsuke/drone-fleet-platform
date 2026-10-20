# 複数機体運用デモと制約

v0.4.0のローカル手順。groupの所属と操作対象の違い、機体別の結果と全体結果、alertの確認と解除、auditの関連付けを確認する。AWS・実機・認証サービスは不要。通常の開発環境とは別のCompose projectとvolumeを使う。

## 起動

Docker EngineとCompose v2を用意し、repository rootで実行する。初回buildは数分かかる。以下の全コマンドは同じrootで実行する。既に同名のデモを使っている場合は再開になるので、保存データを消さずに状態を確認する。

```sh
API_PORT=18148 DASHBOARD_PORT=15148 DRONE_COUNT=10 \
  docker compose --env-file /dev/null -p fleet-v040-demo up --build -d --wait
docker compose --env-file /dev/null -p fleet-v040-demo ps -a
curl --fail http://127.0.0.1:18148/devices
```

通常の`.env`を読み込まず、Composeのローカル既定値を使う。shellへexport済みのCompose用環境変数がある場合は事前に確認する。既存の18148 / 15148番portを使っている場合は両方の値を空きportへ揃えて変更し、以下のURLも読み替える。DB・MQTTはホストへ公開しない。`migrate`の`Exited (0)`は正常。alert-evaluatorも起動していることを確認する。

[http://localhost:15148](http://localhost:15148)を開く。CORSの許可originと合わせるため、画面は`127.0.0.1`ではなく`localhost`で開く。機体一覧の`drone-001`〜`drone-010`がONLINEになるまで待つ。以降、画面の状態更新は原則5秒間隔。

## groupを作成し帰還させる

1. 「機体グループ」で名前を「デモ隊」として作成する。作成した名前のリンクから詳細を開く。
2. `drone-001`、`drone-002`、`drone-003`を1台ずつ追加し、確認する。所属3台とONLINE 3台を確認する。groupIdを詳細URLから控える。
3. 「全機体への帰還を確認」を押す。group名、種類、台数、接続状態、重複操作の注意を読み、チェックして確定する。OFFLINEでも対象から自動除外されない。
4. 移動した操作詳細のoperationId、受付時group名・revision、対象3台、各commandIdを控える。受領済み・実行中を経て、約10秒の仮想帰還と保存・画面更新後に3台とも「完了」、全体が「全件完了」になることを確認する。受領ACKだけでは完了にしない。
5. 操作詳細を別タブへ残し、group詳細で`drone-003`を所属解除し、`drone-004`を追加する。現在の所属は変わるが、元operationの対象は001・002・003、commandIdも同じままであることを確認する。新しい操作だけが現在の構成を使う。

1台が複数groupに所属してもよい。同一機体への別commandを同時に開始するとsimulatorで実行競合になることがある。履歴を見てから次の操作を行い、結果不明のまま再送しない。

### 受付と再送

受付はgroup行のロック中に対象・group名・revisionを固定し、operation、target、機体別command/outbox、成功auditを同時commitする。HTTP 202 / ACCEPTEDは受付成功のみを表す。以後の所属変更・group論理削除でも過去の対象は変わらない。

画面は確定時の`Idempotency-Key`と本文をタブのsessionStorageへ保存する。通信エラーで受付が不明なら「同じ要求で受付を確認」を使う。同じkey・同じgroupId/typeなら元operationが返り、commandを追加しない。異なる本文で同じkeyは409。新しい操作には新しいkeyを使う。元の要求が届いていなければ再送時に初めて受け付けられ、その時の構成になる。別タブ間の統合、単一機体APIの冪等受付ではない。

## 結果の読み方

開始期限は受付から30秒、グループ操作の結果確認期限は120秒。期限は同じ意味ではない。対象一覧を絞っても全体件数は変わらない。

| 機体別の状態 | 意味 |
| --- | --- |
| PENDING / SENT | 送信待ち / broker送信確認済み。機体の受領・完了ではない |
| ACKNOWLEDGED / RUNNING | 受領済み・結果待ち / 有効な実行開始通知あり |
| SUCCEEDED / EXECUTION_FAILED | 確かな成功 / 実行失敗の通知を保存した |
| EXPIRED | 開始期限切れ。過去に一度も実行しなかった証明ではない |
| DELIVERY_FAILED / UNRESPONSIVE | 送信失敗 / 受領・結果の確認ができない。物理的な故障とは断定しない |
| UNCERTAIN | 操作開始後の停止などで実行結果が不確定。自動再実行しない |

全件PENDINGならACCEPTED、進行中が残ればIN_PROGRESS、全件成功ならCOMPLETED。進行中がなく成功と不成功が混在すればPARTIALLY_FAILED、成功0ならFAILED。「不成功」は実行失敗だけでなく期限切れ・未応答・結果不明も含む。受領件数は別指標で成功件数へ足さない。

有効な後着の成功・失敗で再集約されるため、終端表示も不変ではない。結果確認期限後の受領ACK・RUNNINGだけでは未応答を解消しない。詳細な優先順位・衝突処理は[API仕様](fleet-operations-api.md#状態の評価)と[実行結果通知](command-results.md)を参照する。単一機体のコマンド履歴の配送状態と、operationの実行評価は別の表示である。

### 混在結果と後着成功の再現

実行失敗・開始期限切れ・未応答を通常simulatorへ無理に起こす代わりに、専用の制御されたE2Eを使う。ホストへNode.js 22.13.0以上と指定pnpmが必要。

```sh
pnpm install --frozen-lockfile
pnpm test:fleet-e2e
```

実simulator 1台とMQTT fixtureで4対象の成功・実行失敗・期限切れ・未応答、対象の固定、同一key、alert確認と後着成功による解除、audit追跡を検証する。通常のデモ環境は操作しない。画面操作はTesting Library＋jsdomと実HTTPであり、ブラウザエンジンの自動テストではない。結果・ログ・自動後処理と実ブラウザ確認の記録は[#147のE2E](fleet-e2e.md)、[保存結果JSON](fleet-e2e-result.json)を参照する。120秒の結果未応答境界をこのE2E単独で検証したものではない。

## alertを発生・確認・解除する

通常のデモではOFFLINEを使う。commandが終わってから、デモのsimulatorだけを停止する。10台すべてが切断されるが、API・DB・evaluatorは動かしたままにする。

```sh
docker compose --env-file /dev/null -p fleet-v040-demo stop simulator
```

1. ナビゲーションの「alert」で「種類」を「通信断」（OFFLINE）、「機体ID」を`drone-001`として「絞り込む」を押す。OFFLINEへ遷移してから60秒と評価・画面更新の時間を待つ。停止検知が遅れる場合はその時間も加わる。表示されなければ接続状態とevaluatorログを確認する。
2. 詳細で「発生中 / 未確認」、根拠、閾値、発生時刻、alertIdを確認する。「確認済みにする」を押し、「発生中 / 確認済み」になることを確認する。確認は解除でも復旧でもない。
3. 次でsimulatorを再開する。

```sh
docker compose --env-file /dev/null -p fleet-v040-demo start simulator
```

4. 新しい有効観測でONLINEが30秒継続し、評価・画面更新が進むと、同じalertIdが「解除済み / 確認済み」になる。鮮度・観測gap条件を満たさなければ、ONLINE表示だけで直ちには解除されない。確認時刻が保持されることも確認する。

初期条件はOFFLINE 60秒→ONLINE 30秒、battery 20%以下30秒→25%以上30秒。batteryには時刻の鮮度と連続した観測が必要で、古いbuffer再送・retained・欠測を回復の証拠にしない。command不成功のうち実行失敗・期限切れは自動解除せず、送信失敗・未応答・結果不明は後着の確かな成功で解除する。確認操作だけで消す「手動解除」APIはない。

温度・位置・飛行安全・容量予測、メール等の外部通知、自動commandは対象外。alertは保存後のDBを既定5秒周期で評価するため遅延し得る。時計ずれ、evaluator停止、古い再送と設定変更時の制約は[alert仕様](alerts.md)を参照する。

## auditで操作をたどる

1. alert詳細の監査リンクを開く。alertIdで絞られた一覧で`alert.raised`、`alert.acknowledged`、`alert.resolved`を探し、詳細のUTC時刻、actor、結果、関連IDを確認する。一覧は自動更新しないため、新着は検索の先頭を再取得する。
2. group詳細から監査リンクを開き、`group.created`、`membership.added`、`membership.removed`を確認する。
3. 操作詳細から監査リンクを開き、`operation.accepted`、対象分の`command.accepted`、`command.execution_changed`、`operation.status_changed`を確認する。関連operationへ戻り、同じcommandIdの結果と照合する。workerの観測周期中に通過した集約中間状態がすべて記録される保証はない。
4. 検索欄のoperationId、commandId、alertId、requestId、期間、actionなどで絞る。条件はAND。次ページはcursorで移動し、条件を変えたら先頭へ戻す。auditの`SUCCEEDED`はその記録対象の保存成功であり、機体の実行成功とは限らない。

HTTP操作は`anonymous` / actorId null（画面では操作者未認証）、内部処理はsystem。requestIdや自己申告headerは本人確認の代わりにならない。アプリの追記専用repositoryとDBのUPDATE / DELETE拒否triggerはあるが、通常ComposeはDB ownerを共用し、管理者は無効化・直接改変できる。署名・hash chain・WORM・外部保管・DB role分離は未実装で、改ざんの防止・検出を保証しない。拒否・失敗のauditはDB停止や応答前のプロセス停止で欠落し得る。自動保持期限・archiveもない。運用上の境界は[audit log](audit-log.md)と[検索仕様](audit-log-search.md)を参照する。

## 上限と検証した規模

`FLEET_OPERATION_MAX_TARGETS`は通常100台、設定可能範囲1〜1000。空groupや上限超過は全体を拒否し、一部だけ受け付けない。1000は設定可能な値であり安定対応の表明ではない。simulatorの台数設定やtelemetryの負荷試験台数と、1操作の上限を混同しない。

[#146の負荷結果](load-testing/fleet-commands.md)はローカルMQTT応答器で10・100台×全件成功/10%失敗/10%未応答×各3回、計18試行。100台の受付は79.36〜136.76ms、詳細APIの試行別p95は30.28〜169.42ms、target/command/outbox欠損0で、初期基準を満たした。実simulatorの飛行・SQLite・telemetryを動かした100台試験ではない。

追加1,000台の全件応答3試行では、初回900成功・100期限切れとAPI timeout 1件があり、残り2回は全件成功。通常上限100を維持する。複数groupの同時負荷、長期履歴、大量alert、AWS経路の性能保証ではない。[集約JSON](load-testing/fleet-146-results.json)と[raw結果](load-testing/fleet-146-results.tar.gz)に失敗試行も残す。#147は4対象の横断E2Eであり負荷試験を代用しない。

## 終了・再開

```sh
docker compose --env-file /dev/null -p fleet-v040-demo down
```

専用containerとnetworkを削除する。PostgreSQL・Mosquitto・simulatorのvolumeは残り、冒頭の起動で再開できる。デモの履歴も消してやり直す場合だけ、次を使う。他projectのデータは対象にしない。

```sh
docker compose --env-file /dev/null -p fleet-v040-demo down --volumes
```

ログは`docker compose --env-file /dev/null -p fleet-v040-demo logs api telemetry-ingestor alert-evaluator simulator`で確認する。AWSリソース・Git tag・GitHub Releaseの作成はこの手順に含めない。

## 手順の確認記録

2026-10-20、macOS 14.5 / Apple M2 / OrbStack、containerのNode.js 22・PostgreSQL 17・Mosquitto 2.0.22で、上記の10台Composeと実ブラウザから確認した。group作成、3台の追加、RETURN_HOMEの3台成功、所属001/002/004への変更と名称変更後も元operationが001/002/003・受付時名を保持することをAPIと画面で照合した。

operationIdは`b29e14c0-2202-4d6b-957d-3c50e5936432`。OFFLINE alert `b1b63c84-23a6-4e11-9b53-fd65151a1547`は既定の60秒・回復30秒を変更せず、発生05:22:35.367Z、確認05:23:00.753Z、自動解除05:23:50.450Z（UTC）を確認した。同じID・確認時刻を保持し、画面とauditの`alert.raised / acknowledged / resolved`、operationの受付・command実行・集約変更を確認した。これは今回の専用環境の記録で、上記のIDを新規デモへ入力する必要はない。

この確認で見つかったdashboard originからのPATCH / DELETEのCORS事前確認を修正し、画面からの名称変更・所属解除を再確認した。許可外originを認めないAPIテストも追加し、通常の接続元制限は維持した。確認後に専用container・volume・network・imageを削除し、残存がないことを確認した。AWSには接続していない。
