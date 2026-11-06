# ROS 2観測の変換と保存

Issue #192。[ADR 0008](adr/0008-ros2-bridge-contract-and-recovery.md)の観測部分を実装する。既存telemetry v1/v2、simulatorのGPS・飛行状態の意味は変更しない。ROS Action送信や能力報告、画面のLOCAL表示は含まない。

## 通信と単位

同じ`fleet/v1/devices/{deviceId}/telemetry`へschemaVersion 3をQoS 1・retainなしで送る。型と検証は`packages/protocol/src/ros-observation.ts`、正常・不正例は`packages/protocol/test/fixtures/ros-observations.mjs`に置く。`pnpm protocol:export:ros`でPython用JSON Schemaとfixtureを生成する。構造とvalue/qualityの整合条件を共有し、両言語で同じfixtureの採否を検査する。

`payload.source=ROS2`、batteryはnullableな%、temperatureはnullableな電池温度°C。BatteryStateのpresent=trueかつ有限0〜1を100倍する。0は欠測ではない。NaN・範囲外・不在をnull/INVALIDにし、温度も有限値だけを扱う。

positionはLOCAL、GEODETIC、nullのいずれか。Odometryは参照namespaceのmap/base_linkを要求し、poseとvelocityのframeを別々に保持する。poseはENU・m、linearはm/s、angularはrad/s。負のzを保つ。frame不一致ではnull/FRAME_MISMATCHとし、TF補間・GPS化しない。NavSatFixは有効fix・有限かつ範囲内の緯度経度のみ受け付け、高度はnullableなWGS84楕円体基準m。参照nodeはfixを発行しない。

flightStatusはruntime_stateの既知3値だけを写し、それ以外はUNKNOWN。MQTT ONLINE、速度0、diagnostics OKから飛行readyを推測しない。diagnosticsはname/hardwareId/levelだけのallowlistとし、自由message/valuesは送らない。32 component、識別子各UTF-8 256 byteへ制限し、切詰めをdiagnosticsTruncatedへ残す。packetは32 KiBを超えれば生成停止する。

各fieldのqualityにreason、source stamp（sec/nanosec）、timeDomain（SYSTEM/ROS）、clockEpoch、Bridge受信UTCを保持する。送信timestampはsnapshot UTCであり、ROS時刻をUTCへ変換した値ではない。

## 鮮度とQoS

battery/odometry/fixはBEST_EFFORT・VOLATILE・depth 5、diagnosticsはRELIABLE・VOLATILE・depth 10、runtime_stateはRELIABLE・VOLATILE・depth 1。要求deadlineは2秒。QoS不適合eventをQOS_INCOMPATIBLEとして記録し、通常のpublisher停止によるSTALEと区別する。local healthにはobservation_quality、observation_qos_incompatible、observation_clock_epochを出す。

受信ageはmonotonicで3秒未満だけ有効。SYSTEM source stampもUTCとの差が3秒以上ならSTALEとする。sim clockはUTCと比較しない。同stamp再受信は鮮度を延長しない。sourceの0・逆転・monotonicとの差が30秒を超えるjump・time domain変更ではwindowを破棄し、clockEpochを更新して次のsourceを待つ。

snapshotは最大1 Hz（ADRの最大5秒周期以内）。ROS初回受信前は生成せず、新sourceもquality変化もなければ生成しない。欠測・STALEはnull/UNKNOWN/空diagnosticsと理由を送る。再送ではtimestamp・quality・session・sequenceを変更しない。

## 永続化とAPI

Bridge起動ごとにUUID v4 sessionを新規生成し、MQTT再接続では維持する。SQLite WAL/FULLへcommitしてからpublishする。未確認分は最大100件を走査し、各行を5秒間隔で再送する。broker PUBACKでは削除せず、自機・session・sequenceが一致するSTORED receiptのcommitで削除する。旧sessionも再起動後に配送する。

telemetry outboxはinbox/lifecycleと別枠で、BRIDGE_RECORD_LIMIT/BRIDGE_BYTE_LIMIT（最大10,000件/32 MiB）を適用する。超過時は最古未確認行を削除し、telemetry_lossの累積件数を同transactionで増やす。重要inbox/lifecycleはこの処理で削除しない。書込失敗は生成を止めて終了する。DB/WAL/indexの物理容量、SQLite commit前、volume喪失、未生成サンプルは保証外。

ingestorはv3をros_observationsへ保存する。v2/v3共通のobservation_identitiesで識別子を一意にし、別本文はobservation_conflictsへ記録して正本を上書きせず、receiptも返さない。migrationで既存v2正本を台帳へ移す。device登録・接続更新と観測保存を同じtransactionに含め、commit後だけreceipt v1を返す。retainedだけでONLINEにしない。

更新時は旧ingestorを停止し、migration、新ingestor/API/alert-evaluator、Bridgeの順で切り替える。旧ingestorと台帳を使う新ingestorを同時稼働させない。端末の未確認行はSQLiteへ残して配送を再開する。

- GET /devices：最新のROS観測がGPS観測より新しければ、そのbatteryを返す。UNKNOWNは既存互換のnullへ写す。
- GET /devices/:deviceId：latestObservationに元のv3 messageとreceivedAtを返す。ROS観測が新しければlatestTelemetryはnullにし、古いGPSを現在位置に見せない。
- GET /devices/:deviceId/observations?limit=100：ROS観測履歴を受信順の降順で返す。limitは1〜1000、未登録404、不正指定400。
- 既存の/telemetryは従来のGPS履歴専用とし、LOCALを混在させない。LOCALの画面対応は#197。

低電池alertはVALIDかつ非nullのbatteryだけを評価し、欠測で解除しない。snapshotの繰返しを新しい電池測定へ水増ししないよう、quality.battery.receivedAtを測定の識別時刻として扱う。

## 検証

`pnpm test:ros-bridge`は実DDSのQoS不適合・publisher停止、変換、欠測、時計逆転/跳躍、永続receipt/restart・容量超過を検証する。`pnpm test:ros-observations`は専用Composeで参照publisher → Bridge → MQTT → PostgreSQL → APIを実行し、STALE、DB receipt、重複再送、再起動を確認する。結果・サービスログは表示された一時directoryとCI artifactに保存し、検証用container/volumeを削除する。実AWSや実機の試験ではない。
