# OTA進捗の保存と証拠評価

#170でingestorのOTA受信、保存receipt、API内の照会・評価worker、deployment一覧/詳細APIを追加した。端末内`APPLIED`とbackendの`SUCCEEDED`は別の状態である。[ADR 0007](adr/0007-ota-update-evaluation-and-recovery.md)と[通信仕様](ota-protocol.md)を前提とする。

## 有効化と責務

APIとtelemetry-ingestorの両方へ`OTA_ENABLED=true`を設定する。通常起動は無効のままで、`compose.ota.yaml`を指定した構成だけ明示的に有効にする。APIのrelease/deployment routeには従来どおり`OTA_RELEASE_DIR`と`OTA_TRUST_STORE_PATH`も必要となる。

- supervisor：実配信物の検証・切替・子の起動・health採取・journalと報告再送。
- telemetry-ingestor：topic/deviceId・QoS 1・retainなし・16 KiB上限・schemaを検証し、DB transactionのcommit後にだけreceiptを送る。
- APIのmonitor：発行済みattemptを再走査し、QUERY_STATEを保存してから送信する。APPLYの作成/再適用やstageの解禁は行わない。
- DB：正本event、衝突/不採用理由、query/challenge、評価履歴を保持する。deployment lockは`ota-deployment:<deploymentId>`で共有する。#171の解禁・停止処理もこのlockと停止latchを確認する必要がある。

新たなAWSサービスやtopic権限は追加していない。管理APIの認証・認可、実機の安全、暗号学的な実行証明も追加していない。localの匿名brokerは端末の本人性を保証しない。署名者・ホスト・supervisorを信頼する境界は従来どおりである。

## 初回の現在版・能力の観測

初回deploymentより前にはattemptが存在しないため、attempt専用VERSIONを捏造しない。既存の`ota-events` / `ota-receipts`に、別のstrict schemaを持つ`type: INVENTORY`を追加した。旧PROGRESS/VERSION/HEALTH/STATEとそのreceiptの必須scopeは変えていない。新旧supervisor/ingestorを揃えてから有効にする。

supervisorは起動中の子からfreshなIPC応答を採取し、おおむね5秒ごとに実release/version/build/digest/boot、Linux platform、Node.jsとprotocol/supervisor/state schemaのversionを報告する。不明な子やfault状態では観測値を作らない。SQLiteには単調なinventory sequenceと未確認1件を保存し、PUBACKでは消さない。対応するinventory receiptのdeviceId/eventId/hashが一致した場合だけ未確認欄を空にする。

backendは登録済みreleaseとの全identity/application/platform一致、測定の鮮度15秒未満、sequenceと受信時刻の前進を確認して`ota_device_states`へ反映する。device自体は従来のtelemetry/status経路で登録されたものに限る。未登録版・古い報告も観測履歴と理由を保存するが、現在版を更新しない。同じeventの再送は同じreceiptを返すだけで、観測時刻を更新しない。device fenceはinventoryで初期化・減少させない。

INVENTORYは稼働構成の報告であり、health成功や更新attemptの成功証拠ではない。通常の旧simulatorにはこの報告を追加せず、OTA非対応のままとする。

## eventの正本・重複・衝突

`serializeOtaEvent`のcanonical bytesに対するSHA-256を保存する。同eventId・同hashは元のreceiptを返す。receivedAt/storedAtやchallengeを再消費せず、保存済みhealthを新鮮にしない。同ID/別hash、同attempt/sequence/別eventは`ota_rejections`へ保存し、元eventを変更せず、異なる本文へreceiptを返さない。

既知のattemptについて、保存済みのAPPLY payload・target/device/stage/deployment・commandId・fence・releaseを照合する。最新ordinalのattemptと現在の予約・device fenceが一致する報告だけが現在状態を進める。不明attempt、別scope、未解禁HELDは理由付き拒否履歴に残す。古いattemptの事実は保存してreceiptを返せるが、現在attemptを更新しない。

sequenceの到着順に進捗を巻き戻さない。欠番・逆転は履歴として残し、欠番がある間は成功を評価しない。受信事実と評価は分けるため、保存済みだが不採用のeventへもSTOREDを返せる。scope違いや正本衝突には返さない。

`ota_events` / `ota_evaluations` / `ota_inventories` / `ota_rejections`はDB triggerで更新を拒否する。訂正は新しい履歴にする。DB管理者による削除・故障への耐性や無制限保存の保証ではなく、初期実装には自動archiveを含めていない。

## 継続healthと期限

評価仕様は`ota-health-v1`。端末の主張を無条件に信用せず、次をすべて要求する。

1. 同attemptにRECEIVED、DOWNLOADING、VERIFIED、QUIESCING、SWITCHING、BOOTING、HEALTH_CHECKING、APPLIEDの順序付き事実があり、sequenceを補完していない。
2. 新子のVERSIONのrelease/version/build/digestが目的releaseと一致する。SWITCHINGからの起動を、同supervisor bootの端末時刻差とDB観測差の双方で30秒以内と確認する。
3. backendが5秒周期で発行した一回限りのchallengeとQUERY IDに対応し、同じ子boot/supervisor bootで採取されたHEALTHである。要求を発行する前の測定、別boot、使用済み/不明challenge、15秒以上の遅延は継続標本へ入れない。
4. 7項目のcheckがすべてPASSEDで、13標本以上、monotonicとDB保存時刻の双方で60秒以上、標本gapは双方とも10秒以下。時刻の逆転や同じ測定時刻での水増しでもwindowをリセットする。
5. 最後の標本が評価時点で15秒未満であり、すべての根拠が`receivedAt < resultDeadline`かつ`storedAt < resultDeadline`である。期限ちょうどを期限内へ丸めない。

receivedAtはMQTT handlerの受信UTC、storedAtと期限走査はDB clockを使う。storedAtは保存transaction内の時刻であり、PostgreSQLのWAL commit timestampを計測した値ではない。端末UTCの信頼とhost/DBの時刻同期が必要で、自己申告の受信時刻を受け付けない。

明示health失敗はFAILED、矛盾した終端・scope内のrelease不一致・正本衝突や期限時の根拠不足はUNCERTAINとし、現在targetをWAITING_FOR_HUMAN等へ進める。新しい評価へ根拠ID・理由・仕様versionを記録し、以前の成功記録は削除しない。成功後に届いた不良証拠も新評価と停止latchへ反映する。単なる照会や遅着でFAILED/UNCERTAINを成功へ戻さない。

後続の安全な解禁を防ぐため、不確定・integrity違反、または観測済みFAILEDが固定stage分母の10%以上になった時点でstageをSTOPPING、deploymentをWAITING_FOR_HUMANへ保持する。停止を確認せずPAUSEDにしない。STOP_UPDATE送信・端末停止確認・予約解放、開始期限切れを含む段階全体の集約と操作workflowは#171の範囲である。予約や旧版を勝手に解放・切り戻ししない。

## backend再起動と再照会

monitorはメモリ上の標本数を正本にしない。DBのevent/challenge/評価から再開し、未判定の期限切れattemptも再走査する。候補VERSIONの確認前はchallengeなしSTATE照会、確認後はbootを固定したhealth照会を使う。backend再接続時も期限やattempt/fenceを延ばさない。

QUERYは不変payload・15秒期限をDBへ保存し、送信前に試行回数と次回時刻をcommitする。配送失敗では同ID/payloadを上限1〜8秒のbackoff/jitter、最大5回まで再送する。QUERYのpayload/期限・boot・challengeは発行後変更不可、消費済みchallengeも再利用しない。受領なしのまま開始期限に達した配送はEXPIREDとし、遅着の受領で期限内配送へ戻さない。受領済み適用は開始期限だけでは取り消さず、結果期限まで照会・評価を続ける。通常commandとOTA照会は同じpublisher queueを使い、AWSの固定clientIdを並行接続させない。

自動照会はattemptごと最大144件、結果期限後60秒までに限定する。backendが長期間停止していた場合も期限評価は実施するが、無期限の照会・再適用はしない。期限後の照会は現状確認だけで、元の成功期限は変えない。上限後や古くなったhealthの再確認・明示再開は後続の運用操作で扱う。

## 進捗API

- `GET /deployments?limit=20&before=<UTC時刻>`：createdAt降順、最大100件。status、固定targetCount、target状態の内訳、次ページ用nextBeforeを返す。再試行や未応答を分母から除かない。
- `GET /deployments/:deploymentId?stageId=<UUID>&eventLimit=20`：固定release/policy/stage/target、現在観測版、attemptごとの配送・適用・評価、期限、freshHealth、event採否・理由、拒否/衝突、評価根拠を返す。eventLimitは1〜100、評価/拒否履歴は各20件までで、eventの切詰めはeventsTruncatedで示す。

各応答はrepeatable-readのDB snapshotで組み立てる。GETで履歴を成功へ書き換えない。成功評価が過去にあっても、healthが古い・別bootならfreshHealthを成功の代わりに使わない。最新評価のSUCCEEDEDだけでstageを解禁せず、#171で現在のversion/boot/鮮度と停止latchを再確認する。

## 検証と対象外

`pnpm test`は評価単体・通信schema・保存後receipt・機密情報を含めない拒否を検証する。専用PostgreSQLの`pnpm api:test:integration`は同時報告、重複/衝突、期限境界、challenge消費、backend再生成とrollbackを確認する。

`pnpm test:ota-backend`は専用ComposeのMQTT/PostgreSQLとLinuxの実bundleを使う。実観測のbaselineから受付し、通常RETURN_HOMEの完了確認、異なる配信物への適用、保存receiptを1回落とした再送、途中のbackend停止/再開と継続healthを確認する。#171の解禁APIは未実装なので、解禁済みsnapshotだけをfixtureで用意する。公開APIによる承認・APPLY worker・段階解禁を含むデモとは扱わない。終了時は専用container/network/volumeを削除する。

全crash境界・10台段階配信は#175、段階/停止は#171、承認付き復旧は#172、実AWSのOTA・実機は未検証である。
