# OTAのローカル実更新・停止・復旧デモ

v0.5.0の対象はLinux arm64/x64・Node.js 22のsimulatorアプリである。固定supervisorが署名済みbundleを取得し、旧子アプリを終了して新bundleを起動する。version値だけを書き換えるデモではない。Edge Agent、OS、Node.js、supervisor、飛行制御firmwareの更新は未実装である。

## 1. 独立した10台デモを実行する

Node.js 22.13以上、pnpm 10.28.1、Docker EngineとCompose v2を使う。macOS/WindowsではLinux containerを実行できる環境が必要になる。リポジトリのルートから実行する。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test:ota-fleet
```

通常の`.env`、開発DB、AWS project、既存証明書を使わない。専用Compose内のPostgreSQL 17とMosquitto 2、Linux Node 22のrunnerを起動し、各シナリオに独立した10台・SQLite・使い捨てEd25519鍵・実bundleを用意する。ホストの3000/5173番へ接続する手順ではなく、APIはrunner内の公開routeを使う。ブラウザ操作のE2Eではない。

各シナリオで旧版と新版のbundleを作成・署名し、不変objectを配置してrelease APIへ登録する。実際のRETURN_HOME完了後にdeploymentを受け付け、次を順に検証する。固定の60秒healthを短縮しないため、全体は十数分以上かかり得る。上限は各シナリオ660秒、CIジョブ35分で、完了時間の保証ではない。

| シナリオ                 | 確認する結果                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staged-success`         | 1/3/6台の各段階を明示承認。前段階全件成功まで後続APPLYを送らない。全10台の新boot・版・digest、温度出力差4、COMPLETEDを確認。backendを先行health中に再起動し、独立worker 2個を使用                                                        |
| `canary-health-rollback` | 先行機体の新アプリ起動後にtelemetry保存receiptを遮断。異常停止・後続9台未更新を確認し、receipt復旧と人の判断・準備・rollback承認後に旧版の60秒healthを評価。元更新FAILED、target RECOVERED、deployment WAITING_FOR_HUMAN、予約10台を維持 |
| `rollback-failed`        | rollback後のreceiptも遮断。回復FAILEDを元更新の失敗と別に残し、再帰rollback・後続配信をしない                                                                                                                                            |
| `rollback-unavailable`   | 旧版の信頼鍵を失効扱いにして回復UNAVAILABLEを記録。署名済みでも失効鍵を許可しない                                                                                                                                                        |
| `missing-reports`        | 新版起動後のOTA報告を遮断。同じkeyの停止要求を並行送信し、停止未確認は60秒後に人間判断へ。報告復旧後も自動昇格しない                                                                                                                     |

障害系では旧attemptの重複遅着も流し、保存正本・現在状態・bootを変えないことを確認する。rollback前は新版simulatorの仮想飛行を端末側のRETURN_HOMEで終了する。この直接MQTT操作をHUMAN_REVIEWへ記録し、通常APIのOTA予約gateは迂回可能に変更しない。画面から帰還できたことや自律復旧の証明にはしない。

1シナリオだけ確認する場合は、引数をそのまま渡す既存スクリプトを使う。

```sh
bash scripts/test-ota-fleet.sh -t 'canary-health-rollback'
```

`pnpm test:ota-fleet -- -t ...`は使わない。余分な`--`がVitestまで渡り、意図した絞り込みにならない場合がある。

### 結果と後片付け

起動時の`OTA E2E results: <directory>`を控える。`test.log`の`OTA_FLEET_REPORT`はシナリオごとのJSONで、対象・attempt・評価・復旧・介入・時刻・転送body bytesを含む。成功は`5 passed`と全reportの`passed: true`、後片付けは`cleanup.log`の`cleanup=SUCCEEDED test_exit=0`を確認する。絞り込み時は対象1件の成功と残りskipを確認する。

スクリプトは成功・失敗・通常の割込時に専用projectのcontainer/network/volume/runner imageを削除し、残存も検査する。共有base imageとbuild cache、ホスト上の結果ログは残す。ログには使い捨て識別子と運用記録が含まれるため、公開前に確認する。CI artifactは14日保持で、長期監査保管ではない。

host停止や強制kill後はtrapが走らない場合がある。ログに表示された正確なproject名とCompose labelを照合してから、そのprojectだけを片付ける。通常開発projectのvolumeを指定しない。

```sh
# ログの実際のproject名へ置き換え、対象を確認してから実行する。
docker compose -p ota-fleet-REPLACE -f compose.ota-test.yaml ps -a
docker compose -p ota-fleet-REPLACE -f compose.ota-test.yaml down --volumes --remove-orphans --rmi local
```

AWS資源・課金APIは使わないが、ローカルcompute・通信・disk消費はある。costは未計測のnullであり0円とみなさない。高台数・連続負荷、実AWS OTAの費用はこのデモの対象外である。

## 2. 自分の配信物を作成・署名する

上の自動デモは既存鍵・配信物を変更しない。任意のlocal配信物を作る場合は次を使う。空の一時領域にbaselineと新版を生成する例で、Git管理下や既存の`secrets/ota`へ上書きしない。

```sh
demo_dir=$(mktemp -d "${TMPDIR:-/tmp}/ota-signing-XXXXXXXX")
demo_dir=$(cd "$demo_dir" && pwd -P)
corepack pnpm build
corepack pnpm release:tool keygen "$demo_dir/signing" "$demo_dir/trust"
corepack pnpm ota:bundle docs/examples/ota-build.json "$demo_dir/baseline.mjs"
corepack pnpm release:tool pack docs/examples/release-manifest.json "$demo_dir/baseline.mjs" "$demo_dir/signing/private.pem" "$demo_dir/objects" "$demo_dir/baseline.json"
corepack pnpm ota:bundle docs/examples/ota-update-build.json "$demo_dir/update.mjs"
corepack pnpm release:tool pack docs/examples/ota-update-manifest.json "$demo_dir/update.mjs" "$demo_dir/signing/private.pem" "$demo_dir/objects" "$demo_dir/update.json"
```

`pwd -P`で一時領域を実pathへ正規化する。macOSの`/var`等のsymlinkを含む配信領域は安全検査で拒否される。例のmanifestはlinux-arm64である。x64で実行する配信物は、両manifest設定を一時領域へコピーしてplatformをlinux-x64へ変更し、そのコピーをpackへ渡す。build設定とmanifestのreleaseId/version/buildIdは必ず一致させる。別の配信物には新しいUUID・SemVer・buildIdを付ける。同releaseIdまたは同(application, version, platform)を別内容で再登録しない。

署名はEd25519、署名対象はmanifestのcanonical JSON、digestは圧縮archiveのSHA-256である。CLIがdigest/sizeを計算し、envelopeは余白や改行を付けず出力する。秘密鍵は署名端末だけに保持し、API・artifact・supervisor・MQTTへ渡さない。公開鍵のrotation/失効は手動管理で、失効前の版へ戻せるとは限らない。使い捨てデモ鍵を本番へ転用しない。

## 3. 継続起動する1台で登録・操作する場合

上記10台デモと別の、手動確認用構成である。[端末のbootstrap手順](ota-device.md#bundleの生成とbaseline導入)を使い、baselineを登録してから空の専用state/dataへ手動bootstrapする。設定は[ota-device.json](examples/ota-device.json)。`compose.yaml`・`compose.releases.yaml`・`compose.ota.yaml`を重ね、`OTA_LOCAL_OBJECTS_DIR`、`OTA_LOCAL_TRUST_DIR`、`OTA_BASELINE_MANIFEST`、`OTA_DEVICE_CONFIG`を自分の配信物・公開鍵・設定へ向ける。任意の外部originを指定せず、Docker networkの実subnetをallowlistに設定する。

第2節の`demo_dir`を保持した同じshellで次を実行する。既定の3000/8080番等が未使用であることを確認する。別projectでもホストportの衝突は自動回避しない。

```sh
cp docs/examples/ota-device.json "$demo_dir/device.json"
export OTA_LOCAL_OBJECTS_DIR="$demo_dir/objects"
export OTA_LOCAL_TRUST_DIR="$demo_dir/trust"
export OTA_BASELINE_MANIFEST="$demo_dir/baseline.json"
export OTA_DEVICE_CONFIG="$demo_dir/device.json"
ota_project="ota-manual-$(date +%s)"
ota_compose() {
  docker compose -p "$ota_project" -f compose.yaml -f compose.releases.yaml -f compose.ota.yaml "$@"
}
ota_compose up --build -d --wait api artifacts mqtt telemetry-ingestor
curl --fail-with-body -H 'Content-Type: application/json' \
  --data-binary @"$demo_dir/baseline.json" http://127.0.0.1:3000/releases
ota_compose run --rm ota-supervisor bootstrap /bootstrap/baseline.json
ota_compose up -d ota-supervisor
```

rootで動くsupervisorはSETUID/SETGID等を必要とし、子はuid/gid 10001、root filesystemはread-onlyである。journal/lock/releaseのstate領域と、telemetry/command SQLiteのdata領域を別volumeにする。機体別volume・deviceIdを共用したscaleは禁止する。秘密鍵をmountしない。API・匿名Mosquittoに本人認証や対象別認可はなく、local・制限ネットワーク以外へ公開しない。

新版envelopeの登録は次の形式で行う。既存baselineとは別releaseであることを確認する。

```sh
curl --fail-with-body -H 'Content-Type: application/json' \
  --data-binary @"$demo_dir/update.json" http://127.0.0.1:3000/releases
curl --fail http://127.0.0.1:3000/releases
```

以下はAPIの操作順である。具体的なIDは応答から取得し、HTTP 202だけで次へ進めない。管理UIの[配信画面](ota-dashboard.md)でも同じ証拠・理由付き操作を確認できるが、自動デモはブラウザ操作を検証しない。

1. 予約前に通常のRETURN_HOMEを実行し、実行SUCCEEDEDとIDLEを確認する。OTA対応INVENTORYが登録され、15秒未満の実稼働版と能力を観測できるまで待つ。旧通常simulatorはOTA非対応である。
2. `POST /deployments`へ`{"releaseId":"<新版UUID>","deviceIds":["ota-drone-001"]}`をIdempotency-Key付きで送る。受付はACCEPTED、対象は固定、全attemptはHELDである。
3. `GET /deployments/:deploymentId`のstageIdを確認し、`POST /deployments/:deploymentId/stages/:stageId/approve`へ`{"reason":"LOCAL_DEMO"}`と操作専用keyを送る。先行も承認が必要で、1台なら1段階、10台なら1/3/6が既定である。
4. GETで配送・適用・評価を別に追跡する。新boot/version/digestと13標本/60秒のfresh healthが揃って初めて評価SUCCEEDEDとなる。前段階全件の成功・現在状態を確認して次段階を明示承認する。
5. 停止は`POST /deployments/:deploymentId/stop`へ理由と別keyを送る。STOPPINGは受付であり、直接の終端/停止証拠が揃ったPAUSED、または未確認のWAITING_FOR_HUMANまで確認する。既適用版は戻らない。
6. 健康失敗からの復旧はPAUSED・前試行終端・新鮮なINVENTORY/health・既知正常版と予算を確認し、`POST /deployments/:deploymentId/targets/:targetId/recover`へ`{"kind":"ROLLBACK","reason":"CANARY_HEALTH_FAILED"}`と別keyを送る。回復評価SUCCEEDED、target RECOVEREDまで待つ。結果不明なら再適用せず判断対応APIへ引き継ぐ。

同じ操作の応答が不明な場合だけ元key・本文で再確認する。keyを変えて操作を重複発行しない。409は状態・証拠・期限を再点検するための拒否であり、判定を緩めたり予約を手動削除したりしない。手動構成での障害注入・rollback前の準備は自動デモと同一ではないため、再現確認はまず第1節の専用デモを使う。

## 4. 成功・停止・復旧の意味と上限

| 観測                            | 言えること／言えないこと                                                       |
| ------------------------------- | ------------------------------------------------------------------------------ |
| 登録201/200、deployment/操作202 | 配信物検証または要求受付。端末の受領・実適用成功ではない                       |
| 受領ACK・DB保存receipt          | 要求受領またはイベント保存。PUBACKも含め、更新成功ではない                     |
| local APPLIED                   | 端末の適用とlocal health。backendの成功評価とは別                              |
| 評価SUCCEEDED・COMPLETED        | 期限内の新boot・版と継続healthの証拠。実機安全や将来の無故障を保証しない       |
| STOPPING／STOPPED／PAUSED       | 要求受付／更新手順の停止報告／全処理中targetの確認。物理停止やrollbackではない |
| recovery SUCCEEDED・RECOVERED   | 別attemptで旧版回復を確認。元更新FAILEDを消さず、自動昇格・予約解放もしない    |
| UNCERTAIN・WAITING_FOR_HUMAN    | 未報告・矛盾・結果不明。未実行・停止済み・再実行可能と推測しない               |

`ota-health-v1`のcheckはeventLoop/telemetry/sqlite/commandReady/mqtt/subscriptions/receipts。5秒間隔、13標本以上、60秒以上、gap 10秒以下、最後の標本15秒未満、採取経過5秒以内を要求する。起動は30秒以内、stage解禁から開始300秒・結果600秒、QUERYは15秒、STOP送信30秒・確認60秒である。期限ちょうどは成功へ丸めず、DB保存期限も確認する。

同一attemptの取得は初回込み3回、総60秒・接続/無進捗10秒。配送は同ID/本文で最大5回。新attemptのRETRYは適用前と確認した一時的download失敗だけ、明示許可後に30秒＋0〜30秒待ち、最大1回。ROLLBACKも明示承認で最大1回。障害検出から15分、target累計受信body 256 MiBをDB/SQLite双方で維持し、再起動で予算をリセットしない。転送body上限は請求全体の上限ではない。

旧artifact/knownGoodなし、失効鍵、非互換state schema、容量不足、disk/journal破損、旧子の停止不明ではrollbackできない。knownGoodは手動baselineで、backend成功から自動昇格しない。2回目以降のdeploymentの旧版とbaselineが違えば、旧版へ戻せるとは限らない。状態DBの破壊的migration・不可逆操作をOTAへ含めない。

## 5. 更新順序と互換性

既存稼働環境では、先にDBと各永続volume・配信物・信頼根を退避し、OTAを無効にしたまま進める。

1. 書込サービスを停止し、`pnpm db:migrate`で既存履歴を保持する追加migrationを適用する。空のDBからの自動デモと、既存データを使った無停止移行は別である。DB downgradeは自動化していない。
2. OTA v1のschema・ingestorの保存/receipt・API/workerを同じ対応版へ更新する。通常command v2、ACK v1/v2/v3、telemetry v1/v2、status/receipt v1を維持する。旧受信側が未知のOTA情報を扱えると仮定しない。
3. 機体別supervisor・公開鍵・baselineを手動導入し、既存journal/activeへbootstrapを重ねない。端末のtelemetry/command SQLiteをrelease外に保つ。Node/protocol/supervisor/state schemaの互換rangeと実能力を検証する。
4. 配信物・信頼根設定を揃えてAPI/ingestorの`OTA_ENABLED=true`を有効にする。旧版/能力のINVENTORYと保存receiptを確認する。未対応端末を対象へ含めると全受付が拒否される。
5. localの実更新・復旧を確認してから先行を承認する。DB・supervisor・信頼根の手動更新を、OTA rollbackで戻せると扱わない。

継続起動Composeのdownはvolumeや鍵を残す。`down --volumes`はjournal・未確認telemetry/command・OTA履歴を失うため、使い捨て専用projectとbackupを確認した場合だけ行う。UNCERTAINをvolume削除・再bootstrap・再起動loopで解消しない。一時署名領域も、実際に参照中のobject/公開鍵/秘密鍵を退避するまで削除しない。

第3節で起動した専用構成だけを停止するには、同じshellの`ota_compose down`を使う。全データを破棄する使い捨てデモであることを確認した場合だけ`ota_compose down --volumes --remove-orphans`を使う。`demo_dir`は自動削除されないため、停止と参照先・退避を確認後にその一時directoryだけを削除する。

## 6. KPI計画との対応と保証範囲

[Notionの実行評価・復旧・介入KPI計画](https://app.notion.com/p/3fe512303eae818cb481e62a47ed9c42)は後続Phaseの計画である。Phase 5の次の記録は土台になるが、汎用Task、executionContextId/modelRefs/policyRefs、KPI集計・目標値は未実装である。

| 後続KPI                    | 現在の根拠と未計測の境界                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autonomous Completion Rate | deployment/target/attemptとevaluationの根拠event ID。必須承認も人間介入なので、本デモを自律完了へ数えない。OTA targetを汎用Taskと同一視しない                                    |
| Intervention Rate          | interventionId・scope・REQUIRED_APPROVAL/FAULT_RESPONSE・audit関連。正常系は必須承認3件、各障害系は必須承認1件＋障害対応2件。匿名actorで本人性は不明、実作業時間は未報告ならnull |
| Recovery Success Rate      | recoveryId・原因/復旧attempt・SUCCEEDED/FAILED/UNAVAILABLE/UNCERTAIN。明示承認のrollbackを「人間介入なしの自動復旧」の分子・分母へ混ぜない                                       |
| Mean Time to Recovery      | recoveryの検出・開始・終了と回復評価の時刻。成功した定義済み回復のみ算出でき、未復旧を0秒にしない。Phase 5の集計APIはない                                                        |
| Cost per Completed Task    | 累計download bytes、試行/イベント/receipt数とcost null。クラウド実費・端末費・人件費の配賦は未実装、無料や0費用へ補完しない                                                      |

評価からrelease/digest・target/attempt/boot・evidenceへ辿り、復旧と介入/auditを関連付けられる。[進捗API](ota-evaluation.md)と[介入API](ota-interventions.md)のページング・履歴上限に注意し、最新の画面だけで全イベントを集計しない。desired releaseと実使用releaseを分け、将来のmodel versionや実機能力を架空に埋めない。

実測は[OTA E2Eの記録と障害マトリクス](ota-e2e.md)、[PR #187の検証](https://github.com/wmsuke/drone-fleet-platform/pull/187)を参照する。10台Linux containerの成功は100台OTAや実機の成功率を示さない。全crash境界の実SIGKILL・電源断、disk故障、host/volume喪失、悪意ある署名者、実AWS OTA、外部HTTPS運用、ブラウザ操作、無停止移行、長時間負荷、物理的安全停止は未確認または対象外である。保存snapshotを用いる端末テスト・制御clockのDBテストと、実MQTT/DB/Linuxの一貫検証を区別する。
