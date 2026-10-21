# ADR 0007: OTAの実更新・成功評価・復旧境界

- 状態: 採用する設計。#166でrelease管理・local配信を実装。OTA通信・適用・画面は未実装
- 決定日: 2026-10-21
- 対象: 親Issue #164、#165〜#176。Phase 4の#135完了後の設計
- 計画: [Taskの実行評価・安全な復旧と人間介入KPI](https://app.notion.com/p/3fe512303eae818cb481e62a47ed9c42)（2026-10-19更新の計画案を参照。現行コードとGitHub Issueを実装範囲の正とする）

## 背景と対象外

現行`apps/simulator/src/fleet.ts`は1プロセスで複数機体を起動する。command v2とoutboxは開始期限30秒、受領ACK v2、実行通知ACK v3を使い、SQLiteのSTARTED残存をUNCERTAINにする。これらをversionの書き換えだけでOTAへ読み替えない。

Phase 5はLinuxコンテナ上のsimulator/Edge Agentアプリケーションの更新を対象とする。飛行制御firmware、OS・Node.js・監督プロセス自体の更新、実機の安全保証、汎用Task基盤、KPIダッシュボードは対象外。受領ACK、download完了、HTTP 202、再接続だけでは更新成功にしない。OTAは既定で無効とし、従来の複数機体プロセスとローカルデモを維持する。

## 1. 実際に更新するものとプロセス境界

### 配布形式と起動

配信物は依存JavaScriptをbundleした`tar.gz`と、別送の署名付きmanifestとする。archive内のentrypointを`app/main.mjs`に固定し、Node.js組み込みmodule以外の外部依存、native addon、install hook、shell commandを含めない。起動は固定Node.js executableと固定引数で行い、manifestから任意コマンドを実行しない。初期platformは`linux-arm64` / `linux-x64`、runtimeはNode.js `>=22.13.0 <23`。他OS・runtimeは拒否する。

OTA用Composeでは機体ごとに固定supervisorとその子アプリ1個を起動する。#168で既存の1機体ロジックを呼び出すIPC entrypointを追加し、明示deviceIdで起動する。単に`DRONE_COUNT=1`を設定して全機体を同じ連番IDにしない。更新するbundleには起動時に返すreleaseId・version・buildIdと、検証可能な振る舞いの差を含める。#175では異なるbundleの実行とhealth応答の差を検証する。

supervisorはOTA要求、署名検証、download、排他、journal、子の終了・起動、health採取、報告再送を担当し、更新対象bundleに含めない。候補がcrashしてもsupervisorは残る。supervisorの更新・信頼根の更新は手動の別作業とする。supervisor自身のcrashやvolume故障からの無条件復旧は保証しない。

MQTT接続は機体ごとにsupervisorだけが所有する。同一Thing/clientIdで旧・新アプリやsupervisorを二重接続させない。子の通常telemetry・command・receipt処理はIPC transport adapterを通じて既存ロジックを利用する。子の再起動を偽のbroker再接続として扱わず、既存REBOOTの接続世代・再購読・ONLINE PUBACKの成功条件をadapterでも維持する。認証鍵、journal、trust storeは子から変更できない別権限の領域へ置く。通常の未認証・同一owner Composeだけでこの権限分離が達成されたとは扱わない。

### 配信元と保存

#166でlocalの専用artifact HTTPサービスを追加する。配信物はdigestに基づく不変objectとして保存し、APIは登録metadataのみを管理する。端末は事前設定したoriginの固定pathからreleaseId/digestで取得し、要求中の任意URLを取得しない。localのHTTP例外は閉じたComposeネットワークのallowlistに限定する。本番・外部接続はHTTPS必須。redirect、別origin、userinfo、query内認証情報、path traversal、未許可の解決先を拒否し、DNS解決先も接続時に検証する。

#166では署名用CLIが先にobjectを原子的に配置し、APIと専用HTTPサービスが同じread-only領域を読む方式を採用した。登録APIは外部URLを受け取らずHTTP接続もしない。端末のorigin/DNS/redirect制限は端末clientを追加する#168で実装する。localのホスト検証portもloopbackに限定する。manifestのenvelopeもcanonical JSONだけを受理し、初期互換baselineはNode.js 22.13.0、OTA protocol/supervisor/state schema各1.0.0とする。release全体をDB triggerで変更・削除不可にし、deployment参照は#169で追加する。[手順と現行の境界](../releases.md)を参照する。

AWS IoT Jobsは初期方式では採用しない。Jobsはjob documentと端末からのexecution状態更新を扱うが、それだけで本ADRのhealth成功を証明しない。[公式workflow](https://docs.aws.amazon.com/iot/latest/developerguide/jobs-workflow-jobs-online.html)と[execution states](https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs-lifecycle.html)を参照した。Jobs採用案はクラウド側の段階配信を使える一方、local用との二重実装と追加の認可・費用確認が必要になる。本方式は既存MQTT transportとDBを使ってlocalで再現することを優先し、独自worker・journalの保守を引き受ける。

AWSでartifactを配る方式は本Issueでは実装しない。将来S3等を使う際は保存・GET・転送・署名URL期限も#64の条件と別に確認する。Jobs・Software Package Catalog・MQTTや保存を無料と断定しない。[AWS IoT Device Management料金](https://aws.amazon.com/iot-device-management/pricing/)を実行時に確認する。実AWSのOTA、費用見積もり、リソース作成は今回行わない。

## 2. 配信物の信頼・互換性・制限

manifest v1の署名対象は、releaseId（UUID）、application、version（SemVer）、buildId、platform、nodeRange、otaProtocolRange、supervisorRange、stateSchemaRange、archiveのSHA-256 digest・byte size、entrypoint、healthContractVersion、rollbackCompatibleを含む[RFC 8785 canonical JSON](https://www.rfc-editor.org/rfc/rfc8785)のUTF-8 bytesとする。署名envelopeの`keyId`・`algorithm=Ed25519`・base64署名は署名対象本体から分け、重複JSON key・未知のalgorithm・不正canonical化を拒否する。archive digestは圧縮済みbytesを対象にし、manifestの署名とdigestを混同しない。

署名の公開鍵はsupervisorのread-only trust storeへ事前配置し、keyIdを信頼済み鍵に照合する。配信物自身に付いた公開鍵を信頼根にしない。秘密鍵は署名用端末のGit管理外で保管し、端末・API・DB・MQTT・artifactサービスへ配らない。localデモは専用の使い捨て鍵を生成する。鍵の失効とrotationは署名サービスの自動化ではなく、運用者が信頼根を更新して記録する。署名済みでも失効鍵の候補・rollbackを拒否する。HSM・secure boot・端末のremote attestationは対象外で、署名者・ホスト管理者・supervisorの侵害までは防げない。

同じreleaseIdまたは`(application, version, platform)`の別内容への差し替えを拒否する。登録時と端末の適用前の両方で署名・size・digest・互換性を確認する。versionの大小だけで互換性を推測せず、通常の旧version適用は拒否し、後述の明示rollbackだけで許可する。

初期制限は圧縮32 MiB、展開128 MiB、512 entry、深さ8、機体ごとのartifact領域512 MiBとする。全downloadは60秒、接続・無進捗は各10秒、同一attempt内の取得は最大3回（初回込み）。部分downloadは`.partial`へ置き、再開Rangeは初期対象外。失敗時は候補だけを破棄し、同じ署名・digestの取得を最初からやり直す。総時間・転送予算は再取得分も数える。

streamingで圧縮・展開サイズとentry数を数える。絶対path、`..`、重複path、symlink、hardlink、device/FIFO、実行hook、拡張headerで検証を迂回する形式を拒否する。stagingは専用領域内の新規directoryに限定し、既存activeを上書きしない。容量はarchive・候補・現在版・既知正常版・journalと64 MiBの余裕を実測して確保し、不足なら適用前に拒否する。telemetry/commandのSQLiteを空き容量確保のために消さない。active・既知正常版・参照中releaseはGC対象外で、自動GCの実装までは上限到達で新規取得を拒否する。

## 3. 永続モデルと状態の分離

以下は後続Issueで追加する論理モデルで、現行DB tableが存在するという記述ではない。IDはUUID、fenceはdeviceごとに増える64bit整数をJSONでは10進文字列で表す。

| 単位               | 保存するもの・責務                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| release            | 不変manifest・署名・検証結果・格納digest。参照中は削除不可                                                             |
| deployment         | 受付時の対象、release、段階・health・停止・復旧方針、期限、要求hash、idempotency key scope                             |
| stage              | 固定target集合・順番・昇格承認・開始/終了・停止理由。後続のmembership変更では変えない                                  |
| target             | `(deploymentId, deviceId)`一意、stageId、前version/digest・能力snapshot、現在attempt参照、device予約                   |
| attempt            | targetId、attemptId、commandId、fence、目的APPLY/ROLLBACK、前attempt、開始/結果期限、配送と適用状態                    |
| event / evaluation | eventId、attempt内sequence、発生/受信時刻、bootId、事実・採否理由、評価仕様version、根拠ID、判定と期限超過             |
| recovery           | recoveryId、障害検出・開始・回復確認時刻、原因attempt、復旧attempt、予算、不能理由。元失敗を消さない                   |
| intervention       | interventionId、deployment/target/attempt/recovery、承認/障害対応の区別、actor・理由・開始/終了・操作結果、audit関連ID |

deployment受付は全targetのdevice予約、snapshot、初期stage、初期attemptの送信待ち、成功auditを同じDB transactionで保存する。予約はdeviceId一意で並行deploymentを拒否し、停止要求やlease timeoutだけでは解放しない。後続stageのtargetは待機のまま予約し、初期attemptはそのstageを解禁するまでpublishしない。空集合、不適合機体、重複device、上限超過を全件拒否し、一部受付しない。通常上限は100台、最大10stage、同時適用2台、新規要求1件/秒。これは初期安全設定で性能保証ではない。

予約中は未解禁targetもメンテナンス対象として扱う。deploymentがCOMPLETED/FAILED/CANCELLEDになり、全試行の終端または停止・現在版を確認できたtransactionで予約を解放する。PAUSED/STOPPING/WAITING_FOR_HUMANでは保持し、介入で状態を照合するまで新deploymentや通常commandを通さない。可用性より不明な並行操作の回避を優先する判断である。

HTTP操作者は現在anonymous / actorId nullのまま。idempotency scopeもanonymousとし、同一key・正規化本文hashなら元deployment、異なる本文は409。これは認証・認可の代わりではない。後述の別操作APIもidempotency key・理由を必須にする。

| 軸         | 状態と意味                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 配送       | HELD（stage未解禁）/ PENDING / SENT / ACKNOWLEDGED / EXPIRED / FAILED / TIMED_OUT。受領は適用・評価の成功ではない                                             |
| 適用事実   | RECEIVED → DOWNLOADING → VERIFIED → QUIESCING → SWITCHING → BOOTING → HEALTH_CHECKING → APPLIED。各段階からFAILED、停止可能地点でSTOPPED、判定不能でUNCERTAIN |
| 評価       | PENDING / OBSERVING / SUCCEEDED / FAILED / UNCERTAIN。APPLIED報告だけではSUCCEEDEDにしない                                                                    |
| target     | QUEUED / UPDATING / SUCCEEDED / FAILED / RECOVERING / WAITING_FOR_HUMAN / CANCELLED。UNCERTAIN評価はWAITING_FOR_HUMANとし、事実は別に保持                     |
| stage      | PENDING / RUNNING / AWAITING_APPROVAL / PASSED / STOPPING / PAUSED / FAILED                                                                                   |
| deployment | ACCEPTED / RUNNING / STOPPING / PAUSED / WAITING_FOR_HUMAN / COMPLETED / FAILED / CANCELLED                                                                   |

確かな失敗はFAILED、不足・矛盾・適用の有無が不明ならUNCERTAIN。新しい試行で元attemptを上書きしない。rollbackで旧版へ回復しても元の更新成功率へ加えない。全targetの目的release成功でだけCOMPLETEDとし、旧版回復や未着手取消を全件更新成功に含めない。

## 4. 通信契約と既存commandとの対応

OTAは専用topic・schemaVersion 1を追加する。既存command v2、ACK v1/v2/v3、telemetry v1/v2、status/receipt v1を変更しない。OTAをRETURN_HOME/REBOOTや汎用ACK v3のSUCCEEDEDへ詰め込まず、既存fleet operationの120秒評価にも混ぜない。

| topic（`fleet/v1/devices/{deviceId}/`の後ろ） | 方向                  | 内容                                                           |
| --------------------------------------------- | --------------------- | -------------------------------------------------------------- |
| ota-requests                                  | API → supervisor      | APPLY_RELEASE / STOP_UPDATE / QUERY_STATE                      |
| ota-events                                    | supervisor → ingestor | 受領・進捗・適用・起動・version/health・停止・状態照会への応答 |
| ota-receipts                                  | ingestor → supervisor | DB commit済みeventIdとpayload hashの一致確認                   |

全てQoS 1・retainなし。型・生成/解析・実行時検証は#167で`packages/protocol`へ追加する。新しいOTA topicが未実装の間は運用で送信しない。

APPLY_RELEASEはcommandId、deploymentId、stageId、targetId、attemptId、fence、releaseId/digest、目的、createdAt・expiresAt・resultDeadlineと評価仕様versionを持つ。stop/queryも新commandIdで対象attempt/fenceを参照するが、新適用attemptを作らない。URL、秘密鍵、任意コマンド、自己申告actorを送らない。releaseの取得先は登録済みの固定originとmanifestから解決する。

OTA用command/outboxは新しい論理tableとし、既存command/outboxの「同じtransactionで受付・送信前に試行記録・同じID/不変payload・advisory lock・期限と最大試行数」を再利用する。既存tableのtype制約や30秒期限を黙って広げない。開始期限はstage解禁時から300秒、結果期限は同時点から600秒。未解禁attemptに開始時刻・期限を捏造しない。開始済み適用は開始期限だけで取り消さない。配送は最大5回、既存1〜8秒のbackoff/jitterを使い、受領後の結果待ちと分ける。

未解禁attemptはcommandIdを予約してoutboxをHELDに置き、payloadと期限はnullとする。stage解禁transactionで時刻・期限・payloadを一度だけ確定してPENDINGへ進め、その後は不変とする。STOP_UPDATEは作成から30秒の開始期限と60秒の停止確認期限、QUERY_STATEは15秒の期限を持つ。health用QUERY_STATEには一回限りのchallengeIdも含める。stopの受領だけで停止確認にせず、確認期限後は未確認のまま介入へ移す。

supervisorは要求本文hashと最高fenceを先にjournalへcommitする。同じcommandId/本文なら保存済み受領と進捗を再通知し、同IDの別本文と古いfenceは拒否する。高いfenceでも前の子・適用が動作中なら停止を確認するまで受け付けない。サーバーlease失効は子の停止証明にならない。QUERY_STATEは現状照会だけで、古い要求に適用権限を与えない。

eventはID・attempt内sequence・bootId・release/digest・fence、端末時刻とサーバー受信時刻を持つ。ingestorはdevice/topic/現在attemptを照合し、同eventId/hashの再受信は同じreceipt、不一致はconflictとして保存し正本を変えない。既知でないattempt、矛盾する終端・別bootのhealth、古いfenceの報告は履歴へ理由付きで残し、現在状態を進めない。遅着の前段階は進捗を巻き戻さず、sequence欠落も成功の根拠で補完しない。

受領・進捗・health・照会結果をsupervisorの独立SQLite outboxへ永続化し、DB保存receiptを受けるまで同じeventを再送する。PUBACKでは消さない。再接続時のQUERY_STATEとサーバー再走査で通知喪失を補う。上限は機体ごと10,000 event / 32 MiB、未確認eventは捨てず満杯なら新規適用を停止して介入へ移す。telemetryとは別DBに置く。重要な境界記録はreceipt後も監査用journalへ残し、初期実装で自動削除しない。容量監視と手動archiveは別途必要となる。

AWS Policyは#167で、deviceの自機ota-events publish、自機ota-requests/ota-receipts subscribe/receive、APIのota-requests publish、ingestorのota-events subscribe/receiveとota-receipts publishだけを追加する。retain権限・他機体操作・任意artifact取得権限は付けない。localでも購読先を機体別に限定するが、匿名Mosquitto自体の本人認証にはならない。HTTPの新規権限制御は未実装のため、管理APIはローカル・制限ネットワークのみ。公開・実機運用には別の認証/認可設計が必要である。

## 5. 起動・version・継続healthによる成功評価

初期評価仕様を`ota-health-v1`としてdeploymentへ固定し、後から閾値を変えない。

以下の数値はlocal検証を始めるための設計値であり、実測した性能・実機安全の閾値ではない。変更するときは評価仕様versionとADRを更新し、既存deploymentへ遡及しない。

1. 署名・digest・互換性検証とactive切替のjournal記録がある。
2. 新しい子のPIDとbootIdをsupervisorが採取し、実際にロードしたbundleのdigest、IPCで返したreleaseId/version/buildIdが候補と一致する。旧子は終了済みである。
3. 子自身のhealthが、イベントループ応答・telemetry生成の進行・SQLite読書き・command受付準備の各checkを成功として報告する。supervisorはMQTT接続・購読/receipt経路も確認する。version表示やtelemetryのONLINEだけでは代用しない。
4. 起動は切替後30秒以内。同じbootIdで5秒ごとに採取し、最低13標本、60秒以上の連続成功を要求する。supervisorのmonotonic時刻とサーバー側の観測期間の両方で60秒を満たす。標本gapは10秒以下。crash・新boot・gap超過で継続をリセットし、FAILED checkは失敗根拠にする。
5. サーバーは5秒周期で一回限りのchallengeを送り、15秒以内にDBへ届いた対応healthだけを新鮮とする。supervisorはchallenge受信後に子から採取し、monotonic採取経過5秒以内の標本だけを返す。古い保存eventの再送は履歴として保存しても新しいchallengeの証拠にしない。
6. 判定時の最後の有効healthが15秒以内で、全ての根拠がresultDeadlineまでにDBへ届いていることを要求する。期限ちょうどは締切として扱い、`receivedAt < resultDeadline`の証拠だけで期限内成功を判定する。

時刻はサーバーUTCを期限の正とし、端末UTCが信用できなければ新適用を拒否する。health継続の測定にはmonotonic時刻・challengeを併用する。再送で古い時刻や未観測期間を埋めない。新bootで再開しても元の結果期限は延ばさない。明示health失敗やdigest不一致はFAILED、期限時に不十分・未報告ならUNCERTAIN/WAITING_FOR_HUMANとし、自動適用し直さない。

評価は根拠event ID・仕様version・時刻・理由付きで追記する。成功後の後着不良証拠も隠さず、新評価と障害事象を記録し後続stageを止める。過去の成功記録は消さない。昇格直前には現在のboot/versionとhealthの鮮度を再確認するため、過去のSUCCEEDEDだけで昇格しない。

期限後の証拠はlateとして保存し、元の期限内成功にはしない。照会で現状が判明しても自動昇格を再開せず、運用者による照合と新しい評価記録・理由付き再開を要求する。履歴の成功/失敗を都合よく置き換えない。

## 6. 段階配信・停止・再開

受付時にdeviceIdのASCII順で重複のない全対象を固定し、各targetは必ず1つのstageへ割り当てる。既定は先行1台、次に残りから最大3台、最後に残り全台（10台なら1/3/6、空stageは作らない）。明示構成も受け付けるが、漏れ・重複・順序不正を拒否する。

段階の分母Nはそのstageへ固定した全target数。再試行・rollbackを別targetとして数えず、未送信・未応答・結果不明・取消を除外しない。必要標本数はN、昇格条件はN件すべてが目的releaseの評価SUCCEEDEDで、現状も一致し新鮮なhealthがあること。初期方針では成功率条件を緩める設定は受け付けない。小標本での成功は統計的な安全保証ではない。

早期停止は`FAILED/開始期限切れ/停止に伴う未成功`のtarget数 ÷ Nが10%以上になったとき（境界を含む）。UNCERTAIN・結果期限超過の未応答、署名/digest不正、fencing違反、予算超過は1件でも直ちに停止する。配送未応答は期限まで「結果なし」として保持し、除外・成功にしない。N未満の途中成功だけでは昇格しない。失敗率10%未満でも全N成功を満たせなければ自動昇格せずPAUSEDとする。

上の失敗率の分子は現在も未回復のtargetを各1件として数える。一度発動した停止はlatchとして永続化し、復旧で分子が減っても自動解除しない。過去の失敗target/attempt数・停止時の率・原因は別に保持して画面にも残す。復旧・再評価と明示再開を終えて初めて進行できる。たとえばN=10の1失敗は閾値到達、N=100の9失敗は閾値未満だが昇格不可である。

先行開始・各次段階の解禁は理由付き承認を必須とし、正常時はstageをAWAITING_APPROVALへ置く。承認と障害介入を区別して記録する。承認前にhealthが古くなれば照会・再観測を行い、以前の成功だけで解禁しない。自動の段階解禁は初期対象外とする。

停止APIの202はSTOPPINGへの受付であり、全端末の停止ではない。workerは同じdeploymentロックで新規claim・段階解禁・停止を直列化する。ただしclaim後にpublish済みの要求は撤回できない。未送信を抑止し、送信済み・受領済みtargetにはSTOP_UPDATEを送って状態を確認する。stopを先に受領した端末は同attemptの後着APPLYも拒否するtombstoneをjournalへ残す。適用前ならpartialを破棄してSTOPPED、切替中ならatomic境界を完了して子の状態を確認する。停止のために不明な子を強制終了・自動rollbackしない。

停止応答がないtargetや切替/healthが未確定ならSTOPPING/WAITING_FOR_HUMANを表示し、予約を解放しない。全処理中targetの停止または終端を確認してPAUSEDへ進む。配信停止とrollbackは別操作である。CANCELLEDは未着手targetの取消と全処理中targetの確認を終えた場合に限り、適用済み版を取り消した意味にしない。

ここでのSTOPPEDは更新手順を止めた意味であり、子アプリの停止や機体の物理的な安全停止を保証しない。停止後も稼働する版とbootを画面・照会で示す。

再開は保存済みの対象・release・方針を使い、残るattempt、fence、停止確認、予算、release有効性、能力とhealthを再検証して承認する。期限切れの要求を同IDのまま延命しない。未解禁stage以外の再適用が必要なら新attemptへ分ける。対象・releaseを変更する場合は別deploymentを作る。

## 7. 端末journal・排他・crash境界

supervisorは機体ごとのOS lockと独立SQLite journalを持つ。アプリが使うtelemetry/command SQLiteはrelease directoryの外へ置き、journalとは別の永続volumeにする。状態はdownload開始、検証済み、旧子停止、切替意図、active切替、起動boot、health、last-known-good、報告待ちを記録する。

同一filesystem内の検証済みrelease directoryをfsyncし、active pointerは一時ファイルのfsync→atomic rename→親directory fsyncで切り替える。SQLiteとrename/子の起動は単一transactionではないため、journalに前後のdigest・切替意図を残して実物と照合する。last-known-good pointerも同様に更新し、health成功前には旧既知正常版を消さない。

| crash/障害の境界                      | 再起動時の扱い                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| download/検証途中                     | partialを実行しない。active旧版を維持し、予算内の取得だけ再開可                                                  |
| VERIFIED、旧子停止前                  | active・旧子・期限・通常commandの停止状態を照合して同attemptを継続できる                                         |
| QUIESCING                             | PID/bootIdとOS lockで旧子終了を確認。PID再利用や生存不明ならUNCERTAIN                                            |
| 切替意図後、rename前後                | active pointer・候補digest・journalを照合。旧版なら同attemptの未完手順を継続、新版なら二重適用せず起動確認へ進む |
| 新子起動後、結果保存前                | 同じ子が生存すれば新鮮なhealthで照合。再起動が必要な不明状態は自動再起動せず介入                                 |
| health/成功commit後、通知前           | 保存済みeventを再送。再適用しない。server receiptがなくてもjournalの成功を消さない                               |
| backend停止・DB commit後のreceipt欠落 | 同eventを再送し重複排除。期限超過は成功へ補完せず照合待ち                                                        |
| journal破損・volume消失・pointer矛盾  | 新適用・新子起動を禁止。可能なら旧子の現状を維持しWAITING_FOR_HUMAN                                              |

OTA開始前は通常commandの実行中・STARTED/UNCERTAINがないことと、子のIDLE・更新可能応答を直接確認する。古いtelemetryから安全を推測しない。APIのdevice予約で新規の通常command受付を拒否し、fleet operationも予約機体を含めば全受付を拒否する。予約以前のoutbox・実行と競合するため、supervisorでも新command転送を閉じてから停止可能性を確認する。gate中の通常commandへ受領ACKや実行成功を捏造せず、既存の再送・期限評価に任せる。gate前に開始した操作の終了が不明ならOTAを始めない。Phase 4全体の排他スケジューラを後付けしたとは扱わない。

子の更新可能応答はgateを閉じた後の新しい要求に対するものに限定し、bootId・fenceとIPC要求IDを照合する。古いIDLE応答やIPC内の未処理commandを残したまま旧子の停止へ進めない。

## 8. 制限付き再試行・rollbackと介入

同じattemptのdownload再取得・event配送は適用をやり直す新attemptではない。新attemptには新attemptId・commandId・fenceを付け、原因attempt/recoveryIdへ関連付ける。

初期自動復旧のallowlistは「適用前であることを確認した一時的download失敗」の新attempt 1回まで。download 1attempt内最大3回と合算して転送を記録する。待機は30秒＋0〜30秒jitter、障害検出から総復旧予算15分、targetの累計download上限256 MiB、同時1復旧/targetを守る。試行回数・経過・使用bytesはDBとjournalへ永続化し、再起動でリセットしない。

署名不正、digest不一致、互換性不正、容量不足、時刻不信、fence衝突、適用中または結果不明、旧子の未停止は自動再試行しない。停止したdeploymentの中で勝手に復旧を開始せず、PAUSEDで原因を評価し、復旧許可が記録された場合だけallowlistを適用する。許可・停止・retry操作は#173のinterventionとauditへ理由付きで保存する。

rollbackは自動起動せず、原因確認と明示承認を必要とする。次の全条件を満たす場合だけ、目的ROLLBACKの新attemptで旧既知正常版を適用する。

- 前attemptの停止/終端を直接確認し、未知の子が動作していない。device排他と高いfenceを保持する。
- 旧artifactが残り、digest・署名・鍵の有効性・platform/runtime・supervisor互換性を再検証できる。
- 現在の共有状態schemaを旧版が読書きでき、外部への不可逆操作がない。通常適用も同じstateSchemaを要求し、Phase 5の自動OTAでは破壊的schema migrationを禁止する。
- 15分/256 MiBの残予算と容量があり、rollback attemptは障害ごと最大1回。旧版起動と同じ60秒health条件・600秒結果期限で回復を評価する。

旧配信物なし、失効鍵、非互換schema、disk破損、不明な実行、既知正常版なしではROLLBACK_UNAVAILABLEを記録してWAITING_FOR_HUMANへ移す。rollbackの起動・health失敗も再帰的rollbackしない。DB/telemetryを過去snapshotへ無条件に戻さず、手動退避・復元や交換を案内する。回復確認がなければrecovery成功ではない。元releaseの更新失敗と旧版への回復成功を別の評価に残す。

必須の段階承認と障害対応を別種別のinterventionとして記録する。actorは既存と同じanonymous/systemで、本人性を保証しない。成功操作・状態変更・介入/auditを同じtransactionにし、許可したmetadataと理由コードだけを残す。requestIdは本人確認ではない。署名URL、鍵、payload全文は記録しない。管理者改ざん耐性、拒否時auditの必達は[既存の境界](../audit-log.md)を引き継ぐ。

後続KPI用に検出/開始/回復確認、試行数、介入開始/終了、転送bytes、所要時間と取得できた費用を保存する。未取得の費用・時間はnullで、0へ補完しない。Task全体のKPI実装や目標値設定はここに含めない。

## 9. 実装順・移行・検証の契約

| Issue | 引き渡す契約・検証                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| #166  | manifest/署名・不変release・local配信元。正常/不正署名・digest・path・size・互換性、参照中の変更拒否                                     |
| #167  | OTA v1の型・topic・認可・fence・event/receipt・challenge。旧command/ACK/telemetryを維持                                                  |
| #168  | opt-in supervisor/単一機体IPC・実bundle・journal/排他/atomic切替・health。既存REBOOTとcommand競合の回帰も検証                            |
| #169  | snapshot・stage/attempt・device予約・冪等受付・送信待ち/auditの同時commit。通常command APIにもOTA予約gate                                |
| #170  | event/receipt保存、照会、重複・古い試行・矛盾・期限境界、60秒healthと13標本・鮮度の評価                                                  |
| #171  | 固定分母・昇格承認・停止/再開・worker競合・未応答を残す集約。停止中に後続を解禁しない                                                    |
| #172  | allowlist、回数/時間/転送の永続予算、停止証拠、rollback可能/不能/失敗と回復評価                                                          |
| #173  | 承認/障害介入・理由・actor・auditの整合性。不明費用や時間を0にしない                                                                     |
| #174  | 配送/適用/評価・STOPPING/確認済み停止・rollback/回復の分離表示と安全な操作gate                                                           |
| #175  | 10台・異なる実bundleで1/3/6、署名破損・容量・通信断・全crash境界・旧attempt・停止競合・rollback不能・cleanup。結果と資源/転送/時間を保存 |
| #176  | 実装済みだけで署名/登録/実更新/承認/停止/復旧のデモと費用・削除・更新手順を仕上げる                                                      |

移行はOTAを無効のまま、(1) release/OTA tableの追加migration、(2) protocol・ingestorの保存/receipt、(3) API・workerを停止状態で配置、(4) supervisorと信頼根・baseline bundleを手動導入、(5) version・能力・既知正常版を実測登録、(6) local単体/DB/10台E2E確認、(7)先行deployment承認の順とする。未知の旧simulatorはOTA非対応として受付から除外し、過去のversionやhealthを捏造しない。対象に非対応機体を指定した受付は全体を拒否する。

旧protocolとSQLite/DB履歴は残し、通常10台デモを回帰する。OTA結果が保存できる前に端末だけ更新しない。DB downgradeやsupervisor bootstrapの自動rollbackは行わない。誤った信頼根・schema移行はバックアップと運用者の復旧対象である。

後続の具体的なAPI/table名・Zod schemaは上の契約を実装するIssueで追加する。契約や上限を変更する場合はADRと対応文書を同じPRで更新し、暗黙に実装へ合わせない。本Issueの検証は文書の整合・参照・既存品質チェックまでで、OTAの実更新・crash復旧やAWS動作を検証済みとはしない。

## 参照

- [システム構成](../architecture.md) / [通信仕様](../protocol.md) / [ロードマップ](../roadmap.md)
- [ADR 0005](0005-delivery-and-recovery.md) / [ADR 0006](0006-fleet-operations-alerts-and-audit.md)
- [commandの永続化](../command-durability.md) / [実行結果通知](../command-results.md)
- [Phase 5 親Issue #164](https://github.com/wmsuke/drone-fleet-platform/issues/164)
