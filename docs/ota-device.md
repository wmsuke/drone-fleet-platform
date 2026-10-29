# simulatorの実更新と起動後health

#168で、機体ごとの固定supervisorと更新対象の子アプリを追加した。[ADR 0007](adr/0007-ota-update-evaluation-and-recovery.md)と[OTA通信仕様](ota-protocol.md)に従う。通常の10台simulatorは変更せず、`compose.ota.yaml`を明示した機体だけで使う。現段階はLinux arm64/x64・Node.js 22のsimulatorアプリが対象で、Edge Agent、OS、Node.js、supervisor、firmwareの更新は実装していない。

## 実装した境界

- supervisorだけがMQTT接続・証明書・trust store・journalを持つ。子は既存の1機体simulatorをIPC transport経由で動かし、telemetry・command・receiptの既存処理を使う。REBOOTも実際の接続世代、再購読、ONLINEのPUBACKを確認する。子の更新による終了/起動ではbrokerを偽に再接続しない。
- 署名済みbundleの取得、署名・圧縮size/digest・platform/runtime・protocol/state schemaの検証、専用stagingへの展開、旧子の終了確認、atomicなactive切替、新子の起動とversion/boot確認を行う。旧artifactと手動導入したknown-goodは消さない。
- 更新前にnormal commandの転送を閉じる。子の新しいIPC要求ID・fence・bootを照合し、command queueを処理した上で、実行中/RECEIVED/STARTED/UNCERTAINがなく、直接観測したIDLEであることを確認する。飛行中やRETURN_HOME中なら旧版のまま拒否する。gate中に捨てたcommandへACKを捏造しない。
- 同機体のCLIはLinux `flock`で排他にする。新attemptは最高fenceを超える必要があり、同commandIdの同本文は再適用しない。別本文、古いfence、同attemptの別APPLYは拒否する。受信STOPのtombstoneを残し、後着APPLYを始めない。
- progress、VERSION、QUERYへのHEALTH/STATE、未確認eventをSQLiteへ保存する。eventはDB保存receiptのscope/eventId/hashがすべて一致して初めて確認済みにする。PUBACKでは消さず、同じeventを再送する。

`APPLIED`は端末内の適用・health確認の事実で、deploymentの成功ではない。サーバー側のchallenge消費・期限内DB保存・継続評価は#170、device予約とcommand受付gateは#169、段階/停止集約は#171で実装した。#172で[承認付きrollbackと永続予算](ota-recovery.md)を追加した。独立した新attemptと予算・旧既知正常版・排他の確認を必要とし、失敗時に自動で切り戻さない。

## bundleの生成とbaseline導入

`pnpm ota:bundle`は`apps/simulator/src/ota-child.ts`と依存JSをbundleする。MQTT実装は含めず、Node.js組み込みmodule以外の外部importを拒否する。releaseId/version/buildIdと検証用の振る舞いを生成時に埋め込む。manifestと埋め込みIDが違えば起動確認で拒否する。例のtemperatureOffsetはsimulatorの温度出力へ適用する差分であり、実機制御ではない。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm release:tool keygen secrets/ota/signing secrets/ota/trust
pnpm ota:bundle docs/examples/ota-build.json secrets/ota/baseline.mjs
pnpm release:tool pack docs/examples/release-manifest.json secrets/ota/baseline.mjs secrets/ota/signing/private.pem secrets/ota/objects secrets/ota/baseline.json
cp docs/examples/ota-device.json secrets/ota/device.json
docker compose -f compose.yaml -f compose.releases.yaml -f compose.ota.yaml up --build -d api artifacts mqtt telemetry-ingestor
curl --fail-with-body -H 'Content-Type: application/json' --data-binary @secrets/ota/baseline.json http://127.0.0.1:3000/releases
docker compose -f compose.yaml -f compose.releases.yaml -f compose.ota.yaml run --rm ota-supervisor bootstrap /bootstrap/baseline.json
docker compose -f compose.yaml -f compose.releases.yaml -f compose.ota.yaml up -d ota-supervisor
```

既存鍵がある場合はkeygenを繰り返さず、正しい公開鍵と署名鍵を使う。秘密鍵は署名用端末だけに保持し、Composeへ渡さない。既存releaseと同じID/versionの別内容を登録しない。baselineは実bundleなので、#166の配信確認専用`release-demo.mjs`をbaselineとして使わない。x64ではmanifestのplatformをlinux-x64へ変える。

`ota-device.json`のdeviceId、source、CIDRは自分の環境に合わせる。例のCIDRはDocker bridgeの172.16.0.0/12で、別subnetならallowlistを実際の値に絞って変更する。URLのusername/password、path、query、fragmentは許可しない。HTTPは明示したlocal設定とprivate/loopback解決先だけに限定する。外部配信はHTTPS必須で、DNSの全解決先を接続時にallowlistへ照合する。redirect、任意URL、metadata serviceの取得は許可しない。

baseline導入は明示したbootstrapだけで行う。journalやactiveが存在すれば上書きしない。通常serveで空のvolumeを見つけても、versionを捏造して初期化しない。機体ごとにstate/dataを分け、同じvolume/configで単にcontainerをscaleしない。

## 権限と永続領域

supervisorはLinux containerのroot、子はuid/gid 10001へ落として起動する。root filesystemはread-onlyとし、new privilegesを禁止する。rootの権限は子のUID変更、volume所有者設定と保護fileの読出しに使う。

- `/ota-state/private`：rootだけが読書きできるjournal、lock、active/known-good pointer、download.partial。
- `/ota-state/releases/<digest>`：root所有の不変archive・manifestと展開済みbundle。子にはbundleの読出しだけを許可する。実行前にはarchiveと展開fileの一致も再確認する。
- `/ota-data`：uid 10001が読書きするtelemetry/command SQLite。releaseと別volumeに置き、OTAの容量確保で削除しない。
- `/trust`：事前配布した公開鍵だけ。子が書き換えられる所有者・mode・親directory、data内やsymlinkのtrust storeを拒否する。認証情報・source設定は子の環境変数へ引き継がない。

localの匿名brokerで他者の接続を防ぐ設計ではない。署名者・root管理者の侵害、悪意のbundleによるDoS、host/volume故障への無条件復旧、実機の安全保証は対象外である。AWS transportは既存の接続設定をsupervisorで使えるが、今回実AWSのOTA・認可は検証していない。外部公開には別の認証/認可・ネットワーク設計が必要となる。

## download・journal・再起動

圧縮32 MiB、展開128 MiB、512 entry・深さ8、機体領域512 MiBと64 MiBの空き余裕を検査する。署名検証済みmanifestのsize/digestを使い、途中のbytesを起動しない。1回の取得は総計60秒、接続/無進捗10秒、通信失敗時の再取得は初回込み3回まで。試行回数・転送量をjournalへ保存し、processの再起動でリセットして新適用を始めない。容量到達では新規取得を拒否し、active/known-good、SQLiteや未確認eventを自動GCしない。

SQLiteはWAL・synchronous FULL、directoryと検証済みfileをfsyncする。activeは同一filesystem上の一時fileのfsync → rename → 親directoryのfsyncで切り替え、journalへ前後のreleaseと切替意図を残す。SQLiteとfork/renameは単一transactionではないので、再起動時に実物と照合する。

| 保存されていた境界 | 再起動時の扱い |
| --- | --- |
| download/検証前、旧子の終了が確認済み | partialを実行せず旧activeを起動する。適用はFAILEDとして新しい明示attemptを待ち、自動download再開はしない |
| 切替意図があり、旧子終了済み・新子の起動意図なし | pointerが旧/新どちらでも、同じ検証済み候補へ照合して起動する。同attemptの継続であり新しい適用ではない |
| forkの意図、未確認PID、起動後〜結果保存 | PIDを再利用してkill/再起動せずUNCERTAIN。新適用・新子起動を止める。元の子はIPC切断時に終了を試みるが、終了済みと推測しない |
| APPLIED保存後、正常終了して子の終了を確認済み | activeを起動し、元の結果/eventを残したまま新bootのVERSIONを報告する。過去のhealthを新bootへ流用しない |
| journal破損、pointer不一致、volume消失 | 自動初期化・適用を拒否する。backupと子の実状態を運用者が照合する |

未確認eventとlocal health標本は追記して保持する。自動archive前の保守的な上限として合計約10,000件/32 MiBに達する前に新操作を拒否する。確認済みeventも自動削除しないため、長期運転には運用者によるbackup・点検が必要である。known-goodは手動baselineのまま保持し、local APPLIEDや保存receiptだけでサーバー評価済み版へ更新しない。

## healthと送信可能な状態

子のPID/boot、releaseId/version/buildIdをfreshなIPC要求の応答で確認する。digestは自己申告させず、supervisorが検証して起動したarchiveへ結び付ける。子とsupervisorの時計は同じhostを使う。healthは子の採取UTCと、supervisorが採取要求を開始したmonotonic ms・実測round tripを記録し、採取から5秒以内に限定する。

event loopの応答、telemetry生成の進行、永続SQLiteの読書き、command受付準備、MQTT接続、通常/OTA購読、telemetry保存receiptとOTA event保存receiptの経路を調べる。旧子を止める前に当該attemptのOTA event保存receiptも確認するため、未対応ingestorへ送って端末だけ更新することはしない。

新子では起動を30秒で確認し、5秒間隔で13標本・60秒以上・gap 10秒以下の連続成功をjournalへ保存してからlocal APPLIEDを報告する。FAILED checkや期限超過、別boot・応答不能を成功へ補完しない。QUERY_STATEの一回限りchallengeに対応するHEALTHも採取・永続送信するが、サーバーでのchallenge照合・継続成功評価は#170で行う。

#170で`OTA_ENABLED=true`のingestorへ保存/receiptを追加し、APIがchallengeと継続healthを評価する経路を追加した。[証拠評価](ota-evaluation.md)を参照する。supervisorは初回deployment前にもINVENTORYで実稼働版・能力を報告する。`compose.ota.yaml`はAPI/ingestorのOTAを明示的に有効にする。#171で承認後のstage解禁とAPPLY配送、#172で許可した復旧attemptとrollbackを追加した。`test:ota-device`の限定fixtureと、実MQTT/DBを使う`test:ota-backend`の確認範囲を区別する。

## 検証と停止

```sh
pnpm check
pnpm test:ota-device
docker compose -f compose.yaml -f compose.releases.yaml -f compose.ota.yaml down
```

test:ota-deviceは使い捨てLinux・Node.js 22コンテナで異なる実bundle、温度出力の差、60秒health、health報告、REBOOT/RETURN_HOME、不正署名・digest・互換性、並行要求・fence、権限分離、kernel lockを検証する。切替前後・結果保存境界は保存済みjournalのcrash snapshotから復元し、不明なPIDを動かさないことを確認する。全境界の実SIGKILL・disk故障注入と10台段階配信は#175の範囲である。

downではstate/dataや鍵を消さない。UNCERTAINでは再起動loopやbootstrapによる上書きを行わず、対象の子とjournal/active/known-goodを確認する。既知のPIDが見つからないだけで終了証明にせず、手動復旧を記録する。volumeを消す場合はtelemetry/commandの未確認行とOTA履歴が失われるため、対象機体とbackupを先に確認する。
