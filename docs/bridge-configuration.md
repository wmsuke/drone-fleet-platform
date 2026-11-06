# Bridgeの能力定義と実稼働構成

Issue #193。[ADR 0008](adr/0008-ros2-bridge-contract-and-recovery.md)の構成報告を実装する。ROS Action送信、cancel、操作readyの有効化は#194以降であり、本機能の報告やdesired設定では機体を操作しない。

## 能力と実使用情報

Capability Profile v1.0.0は型式reference_vehicle、RETURN_HOMEから専用ReturnHome Actionへの対応、相対Action名、map/base_link、ENU、m・m/s・rad/s、必要sensor、起動時homeの定義、制約を固定する。REBOOTをnode再起動へ読み替えない。

参照AdapterのGetConfiguration serviceから、実起動server UUID、home ID、既存Adapter設定digest、profile、Adapterの実package versionとsource digest、ROS distro/RMW/Python/architectureとbuild manifest digest、適用運用policy、安全設定を取得する。BridgeはGetRuntimeStateのdevice/server/config/homeと一致した新鮮な報告だけへ自身の実package version/source digestを加える。サービス照会は非同期・2秒期限で、MQTT callbackから待たない。

今回Bridge/Adapterを0.2.0へ更新した。source digestはbuild時にpackageのsource・setup・package.xmlから生成し、runtime manifestは固定OCI・deb・Python依存と全ROS sourceの識別を含む。OCI image digestそのものや暗号学的な実行証明とは異なる。自己申告、信頼した参照実装とMQTT端末認証の境界を残す。

参照の安全閾値は報告と実判定で同じ定義を使う。運用policyは許可操作・制約の識別情報で、AWS IoT Policy（MQTT権限）とは別概念である。AI未使用はNOT_APPLICABLE/NOT_USEDとし、model versionを作らない。Bridge/Adapter/runtimeの情報を取得できない場合のUNKNOWNと区別する。KNOWNで宣言した未対応versionはschemaで拒否し、UNKNOWNを実行可能へ補完しない。

## wireと保存確認

新topicはfleet/v1/devices/{deviceId}/bridge-eventsとbridge-receipts。QoS 1・retainなし。schemaVersion 1のCONFIGURATIONだけを追加し、将来の実行eventを先取りしない。commandIdやgoalIdを構成報告へ捏造しない。

型・実行時検証はpackages/protocol/src/bridge.tsを正とする。pnpm protocol:export:rosでPython用JSON Schemaと共通fixtureを生成する。構成はsafe integerだけを使い、キーを辞書順に並べた空白なしUTF-8 JSONのSHA-256で識別する。浮動小数点の表現差を避けるため制約の距離・時間はmm/msの整数とし、ROS観測そのものの単位は変えない。

BridgeはSQLite user_version 3へ非破壊追加し、journal ID、configurationRevision、reportSequenceを永続化する。同じ構成の再報告ではrevisionを変えず、構成が変わると増加させる。reportSequenceは起動sessionをまたいで増加する。active goalが報告されている間は新しい構成報告を生成しない。報告周期は最大5秒、実ROS照会の結果が3秒未満のときだけ生成する。

eventとcounterを同じWAL/FULL transactionで保存してから配送する。重要eventはinbox/lifecycleと合わせて最大10,000件/32 MiB。最古eventを自動削除しない。満杯・書込失敗はBridgeを非readyのまま停止する。最大5件/秒、1〜8秒backoffで再送し、PUBACKでは削除しない。自機device/eventId/canonical payloadHash/STOREDが一致するDB receiptだけで削除する。未確認eventは再起動後も同じ本文・timestampで配送する。

ingestorはevent正本・受信時刻・採否と構成をtransactionで保存し、commit後だけreceiptを返す。同eventId・同hashは最初と同じreceipt、別本文はbridge_conflictsへhashを残し正本を変更せずreceiptも返さない。同じprofile/component/policy IDとversionの別本文もCONFLICTとして検出する。

現在構成はdeviceごとのheadとし、古いrevision/sequence、同revision別構成、未停止の実行に競合する変更、source UTCと受信時刻の差が15秒を超える報告では戻さない。採否は履歴へ残す。journal IDが変わった報告はJOURNAL_MISMATCHとし、自動再登録しない。永続領域消失後の再登録は別途介入が必要で、今回その解除APIは提供しない。STOREDは保存された証拠の確認であり、CURRENTへの採用や操作可能を意味しない。

## DBとAPI

bridge_definitionsにID/versionごとの定義、bridge_configurationsに構成IDごとの不変snapshot、bridge_reportsにevent正本と採否、bridge_configuration_headsに現在のreportedとdesiredを分けて保存する。PostgreSQL triggerで定義・構成・報告本文のUPDATEを禁止する。

- GET /devices/:deviceId/bridge-configuration：reported、desired、matchesDesired、報告のfresh（15秒未満）、定義上のsupportedOperationsを返す。readyは常にfalse。
- GET /devices/:deviceId/bridge-configuration/reports?limit=100：採否付き報告履歴。limitは1〜1000。
- PUT /devices/:deviceId/bridge-configuration/desired：revisionとconfigurationIdを指定する。同revision別ID・古いrevisionは409。未報告のIDも期待値として設定できるが、配信・適用・reported更新はしない。変更とauditを同transactionで保存する。
- GET /commands/:commandId/bridge-configuration：保存済み実行参照から当時の構成を返す。参照がなければ404。

createBridgeRepository.bindExecutionは#194の実行開始処理へ渡すDB境界である。新鮮な現在報告、desiredとの一致、対応操作、同機体の未停止実行、goal UUIDを確認し、commandId/goalId/configurationId/報告event/開始時刻を不変に結ぶ。後から現在構成へ差し替えない。停止確認なしの実行がある間の構成切替も拒否する。今回この関数からActionや架空の実行結果を作らない。既存simulator commandは変更せず、実ROSの開始・結果経路への接続は#194で行う。DB/API試験の実行参照は明示的な完了・停止確認fixtureで検証する。

## 更新と検証

旧ingestorを停止し、migration→protocol/ingestor/API→Bridge/Adapterの順で更新する。AWS transportでは自機bridge-events publish、自機bridge-receipts subscribe/receive、ingestorの対応受信・receipt publishをTerraform定義へ追加した。APIへの新publish権限や他機体/wildcardのdevice権限は追加しない。実AWSへの適用・検証は行わない。Policy更新前のBridgeを実AWSへ接続しない。

pnpm test:ros-reference、pnpm test:ros-bridge、pnpm test:ros-observationsを使う。実DDS service→Bridge→MQTT→PostgreSQL→API、保存receipt、再送、desired差異、再起動をまたぐcounter、古い報告を検証する。DB/API試験で同ID別本文、UNKNOWN/非対応操作、実行参照の不変性と更新競合を検証する。LOCAL表示は#197、汎用TaskのexecutionContext全体はPhase 7の範囲とする。
