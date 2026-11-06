# MQTT / ROS 2 Bridgeの起動と終了

Issue #191でPythonの`fleet_bridge`を追加した。MQTT transport、非同期ROS client、参照機体Adapterのidentity検査、lifecycle所有者、SQLite journalを分ける。[ADR 0008](adr/0008-ros2-bridge-contract-and-recovery.md)と[固定参照環境](ros-reference.md)を前提にする。

今回は接続基盤だけで、telemetry v3変換（#192）、能力報告（#193）、command/goal実行（#194）、cancel（#195）は未実装。MQTTを購読してもcommand ACKを返さず、ROS Actionを送信せず、機体ownerを取得するheartbeatも送らない。`ready`と`accepting_operations`は常にfalse。受信記録を将来のversionで無条件に実行する契約ではない。

## ローカルで起動する

```sh
docker compose -p fleet-ros-bridge -f compose.ros-bridge.yaml up --build -d
docker compose -p fleet-ros-bridge -f compose.ros-bridge.yaml logs -f bridge
docker compose -p fleet-ros-bridge -f compose.ros-bridge.yaml exec bridge cat /data/fleet/health.json
docker compose -p fleet-ros-bridge -f compose.ros-bridge.yaml down
```

既存の通常Composeやsimulatorと別projectにする。brokerのportやDDS UDPをホストへ公開しない。参照nodeとBridgeは別container/processで、Bridgeが`network_mode: service:reference`と`ipc: service:reference`によって参照nodeのnetwork/IPC namespaceを共有する。Fast DDSが同一hostと認識した際の共有メモリ経路も同じ領域へ到達させる。DDSはlocalhost/domain 42、MQTTだけを専用のinternal Compose networkへ接続する。認証fileやjournalはBridgeだけへmountする。namespace/domainは認証境界ではなく、同居する悪意あるprocessからの安全性は保証しない。

既定は参照2台のうち`ros-ref-001`へ1 Bridgeを接続する。複数機体ではBridge service、`BRIDGE_DEVICE_ID`、永続volumeを機体ごとに分ける。参照namespaceはdevice IDのASCII bytesのhexから導き、手動指定した`BRIDGE_ROS_NAMESPACE`が一致しなければ起動しない。

`down`ではjournalとbrokerの永続volumeを残す。履歴を捨てる必要がある検証環境だけ、対象projectを確認して`down --volumes`を使う。volumeの再初期化を復旧方法として自動実行しない。

## 設定と認証

[設定例](../ros/config/bridge.env.example)を参照する。環境変数だけを読み、設定不備はfield名と固定reasonだけを出してexit 2、runtime/journal不備は固定reasonでexit 1とする。例外本文、endpoint、認証file名、受信本文をログへ出さない。

| 設定 | 制約 |
| --- | --- |
| `BRIDGE_DEVICE_ID` | 必須。既存protocolと同じ英数字・`_`・`-`、1〜64文字 |
| `BRIDGE_STATE_DIR` | 絶対path。既定`/data/fleet`。Bridge UID 10001から書き込める永続volume |
| `BRIDGE_ROS_NAMESPACE` | 省略時はdeviceから導出。任意の別機体namespaceを指定できない |
| `ROS_DOMAIN_ID` | 既定42、Linux向け0〜101。discoveryはLOCALHOST、static peerは空、RMWはFast DDSのみ |
| `MQTT_TRANSPORT` | `local`または`aws-iot`。異なるtransportのendpoint設定を混ぜない |
| `MQTT_HOST` / `MQTT_PORT` | localのhost名/IPと1〜65535。URL、userinfo、pathは拒否 |
| `BRIDGE_QUEUE_LIMIT` | 1〜100件、既定100。1受信本文は32 KiBまで |
| `BRIDGE_RECORD_LIMIT` / `BRIDGE_BYTE_LIMIT` | inbox＋lifecycleの論理本文量。最大10,000件/32 MiB。DB/WAL/indexの物理容量は別途確保する |
| `BRIDGE_RECONNECT_MIN_SEC` / `BRIDGE_RECONNECT_MAX_SEC` | 1〜8秒の指数backoff。最大値は最小値以上。接続試行のsocket timeoutは2秒、DNS解決はOS resolverに従う |

AWS設定は既存simulatorと同じ`AWS_IOT_ENDPOINT`、`AWS_IOT_ROOT_CA_PATH`、`AWS_IOT_DEVICE_CREDENTIALS_DIR`を使う。証明書は`<credentialsDir>/<deviceId>/device.pem.crt`と`private.pem.key`。存在・非空・PEM/証明書と鍵の対応を起動時に検査し、秘密鍵のgroup/other権限を拒否する。TLS 1.2以上、CA検証・hostname検証を無効化しない。client IDはAWSではdevice ID、localでは`bridge-<deviceId>`とする。同じdeviceでsimulatorと同時接続しない。

既定Composeは外部接続を許さないlocal専用である。実AWSへ接続する場合は別の運用設定でMQTT egressとBridgeだけへのread-only認証mountを用意し、[既存AWS接続手順](aws/README.md)の費用・証明書・権限条件を確認する。本Issueでは実AWSへの接続やPolicy変更は行っていない。mTLSの実装試験は一時CAを使うローカルMosquittoで行う。

## 接続状態と受信境界

`BRIDGE_STATE`ログと永続領域の`health.json`に`mqtt_connected`、`mqtt_subscribed`、`ros_available`、各reasonを別々に出す。health fileは同じdirectory内でatomic replaceする。MQTT接続だけでは購読完了にしない。SUBACKが全topicでQoS 1になった後だけ`mqtt_subscribed=true`とする。

ROSは型付き`GetRuntimeState` serviceと`ReturnHome` Actionの到達性を調べ、device/frame/server/configurationのidentityを検証する。照会は非同期、1回2秒、同時1件。3失敗後は8秒待つ。最後の応答がmonotonic age 3秒を超えれば`ros_available=false`とする。これは機体の飛行readyではない。前goalや能力の照合を未実装のままwatchdogを延命しない。

MQTT切断でもROS照会を続け、ROS停止でもMQTT接続を維持する。再接続のたびに購読をやり直す。既存の`status` v1へONLINE/CONNECTED、終了時OFFLINE/SHUTDOWN、LWTへOFFLINE/CONNECTION_LOSTをQoS 1・retainなしで送る。ONLINEはBridgeのMQTT接続を表し、ROSのreadyを意味しない。新しいbridge-event/topicはまだ使わない。

自機の`commands`と`telemetry-receipts`だけをQoS 1で購読する。MQTT callbackは最大100件のqueue投入だけを行い、専用のlifecycle workerがSQLiteへ保存する。manual PUBACKはcommit後かつ同じ接続世代だけで返す。満杯・過大packet・QoS不適合ではACKせず切断する。これはbrokerのPUBACKやアプリケーションのcommand受領ACKとは別で、commandを実行可能として受け付けたことを意味しない。

inboxはtopicと本文のSHA-256で重複保存を避け、未実装操作として本文を保持する。受信callback到達後もSQLite commit前は配送保証外であり、brokerの永続session/QoS 1による再配送に依存する。broker保存期間・停止・disk喪失による欠損まで保証しない。Pahoのprocess内queueを永続領域の代わりにしない。

## journalと終了

volumeをOSの排他lockで1 ownerに限定し、SQLiteにdevice identityを固定する。別device、破損、未知schema version、既存の空DBでは起動しない。WAL / synchronous FULLで保存し、満杯・書込不能では新規受信を止めて終了する。inbox/lifecycle履歴は自動削除しない。

SIGTERM/SIGINTでは受信投入を停止し、残ったbounded queueを最大3秒排出してからROS future/executorとMQTT接続/threadを閉じ、最後にDBとowner lockを解放する。未commit分はACKせず、broker再配送へ委ねてexit 1とする。正常な終了はexit 0。不完全な終了を停止成功へ読み替えない。失敗時にも可能な範囲でlocal healthを非readyへ更新する。disk I/OやOS resolver自体の停止、SIGKILLまでアプリケーションの期限で制御できる保証ではない。

送信待ちの接続statusはSQLiteの1行に最新状態だけを残す。PUBACKで削除できるのはこの接続statusだけ。接続が切れて終了した場合はSHUTDOWNが残り、再起動後は現在の接続状態へ置き換える。これはcoalescing可能な状態通知であり、将来の重要bridge-eventやDB保存receipt待ちのoutboxを上書き/削除してよい契約ではない。

## 検証

```sh
pnpm protocol:export:ros
pnpm test:ros-reference
pnpm test:ros-bridge
```

wireの正は`packages/protocol`のZod定義。既存device ID検証を同じ正規表現へ保ったままJSON Schemaへ変換できる形にし、status v1のschemaと正常/不正fixtureを`ros/contracts`へ生成する。Vitestがschema/fixtureのdriftとZodの結果を検査し、Pythonは同じfixtureをfastjsonschemaで検査する。PythonへZod定義を手書き複製しない。command v3や相関検証はまだ追加していない。

追加Python依存は[hash固定wheel](../ros/vendor/README.md)を同梱し、ネットワークなしで展開・buildする。実Mosquittoと独立ROS/Bridge processで、2機体の分離、ROS単独停止/復帰、MQTT経路の切断/復帰、切断中のbroker queue、再起動後の記録保持、接続不能時の終了、設定不備の秘匿、local mTLSを試す。テスト用project・container/image・volume・一時証明書を終了時に削除し、結果をCI artifactへ残す。実機操作やCloudへの保存確認は証明対象ではない。
