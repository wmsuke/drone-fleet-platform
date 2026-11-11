# 実ROS・MQTTのBridge障害E2E

Issue #198。`corepack pnpm test:ros-e2e`で固定Jazzyの参照node、Bridge、Mosquitto、PostgreSQL、API、React画面を接続する。AWS認証情報、実機、PX4、Gazebo、host firewallを使わない。#194〜#196の24ケースを再利用し、9ケースを追加して全33ケースの実行を要求する。

## 実行と対象

Node.js 22、依存関係のインストール、Dockerが必要。ROSは固定Linux image内だけで動かす。専用Compose project名はUUIDで生成し、通常`.env`を読まず、試験専用のDB名・認証情報・volumeを使う。APIだけをloopbackの31194へ公開する。競合時は`ROS_COMMANDS_API_PORT=別port`を指定する。

```sh
corepack pnpm test:ros-e2e
```

`ROS_COMMANDS_CASES`による部分実行は専用E2Eでは拒否する。原因調査用の`corepack pnpm test:ros-commands`と`ROS_COMMANDS_CASES=cancel/recovery`は従来どおり利用できるが、部分試験を全33ケースの成功に読み替えない。

参照nodeは設定を切り替え、1batch最大10台、Bridgeは同時最大2台とする。odometryは10 Hz、battery/diagnostics/runtime/heartbeatは1 Hz、保存feedbackは最大1 Hz。sensor DDSはBEST_EFFORT/volatile/depth 5、runtimeはRELIABLE/volatile/depth 1、MQTTはQoS 1。実行した構成のsource/依存lock・architectureはROS環境manifestへ記録する。これは大規模性能や厳密な制御周期の保証ではない。

## 故障と確認する証拠

| ケース | 注入と照合 |
| --- | --- |
| 基本Action・重複・拒否・失敗 | 実Actionの受理/実行回数、元goal UUID、CDR/hash、DB正本・receiptとAPIを照合する |
| 2台のnamespace/device | Aの有効commandをBのMQTT topicへ誤配送し、Bの隔離・SQLite goal 0・DDS受理/実行0・DB target 0を確認する。両端のLOCAL frameも異なることを確認する |
| 古いfeedback | 実Actionから得た元goalのfeedbackを、終端後に試験用publisherから実DDSへ3回送る（matching subscriberを確認）。同じ元feedbackを別event IDでMQTTにも遅着させ、DBのSTALE採否と終端・停止正本が不変なことを確認する。DDS内部のcallback受信ACKを得たとは扱わない |
| Bridgeの送信境界 | intent前後、SendGoal後、result保存後をSIGKILLし、新しいgoalを作らず元UUIDだけを照会する |
| cache・server世代・期限 | 実cache失効、Action server再起動、120秒の未報告期限と後着証拠を確認する。停止を推定せず、不明はUNCERTAIN・予約保持とする |
| 中断と競合 | 実CancelGoalの受付/拒否/遅延/未知goal、成功との競合、10秒の未確認、中断時の通信断・再起動を照合する |
| MQTTと機体側制約 | broker停止中もローカルで成功、LOW_BATTERY、POLICY_REJECTED、SENSOR_STALEが生成され、再接続後に同じ証拠をDBへ保存する。Cloudから制約を解除しない |
| DDS・node・Bridge・server停止 | UDPのみの遮断、node SIGSTOP/SIGCONT、Bridge SIGKILL、server子process再生成を別々に注入し、再接続だけで停止・復旧成功にしない |
| 過去構成・介入 | 実行時の固定構成/goal/開始参照をserver世代変更後も保持する。中断要求とintervention ID、理由、auditの件数を照合する |
| 実経路を読む画面 | React/jsdomからnative HTTP fetchで実APIを読み、成功/中断/不確定・観測frame/単位・証拠を表示する。画面から実command→Action→理由付きcancelを送り、ROS受付を停止成功にせず、人間判断へ至ることを確認する |

画面試験はHTTP/MQTT/ROSをmockしないが、rendererはReact/jsdomであり、実ブラウザのlayout・全WCAG監査・物理操作の検証ではない。試験用DDS feedback publisherはBRIDGE_INTEGRATION=trueと試験device名を必要とし、goalやheartbeatを送らない。通常Composeへは組み込まない。

## レポートと後片付け

入口が表示する`Results:`の一時ディレクトリへ以下を保存する。

- `report.json`: 全33ケースのPASSED/FAILED/NOT_EXECUTED、process終了値、実測HTTP往復遅延、環境・保持しない保証範囲、cleanup。
- `action-evidence.json` / `current-case.json`: 完了ごとの証拠と進行中ケース。途中失敗で、それ以降を成功扱いしない。
- `metadata.json` / `environment-manifest.json`: commit/関連worktree差分、host/engine/ROSのarchitecture、Node/Python/固定依存、周期/QoS/照会予算、試行情報。
- `http.jsonl`: host harnessが実測した各HTTP要求のstatus/所要ms。画面内HTTPやDDS全sampleの遅延を計測したものではない。p50/p95/maxはこの標本だけから求め、SLOや性能保証にしない。
- `reconciliation.json`: command/goal/結果と構成binding・中断/介入/auditの件数と固定ID。送信意図不明・cache消失では、実行した可能性と保存済みの実開始を区別する。
- `ui-*.json`、サービスログ、各DB正本のJSONL、`cleanup.json`と残存照会結果。

正常終了・失敗・INT/TERMで同じcleanupを通し、専用container/volume/networkとROS・Nodeの専用image tagを削除する。Dockerのbuild cacheと証拠ディレクトリは残す。後片付けの残存や件数不一致、欠けたケースを無視して成功にしない。試験processの失敗とcleanupの成否は別々に記録する。

後片付けの異常系は次で再現する。意図的に終了値が非0になり、全ケースNOT_EXECUTED、process失敗、専用資源のcleanup成功を別々に確認する。

```sh
ROS_E2E_FAIL_AT=after-start corepack pnpm test:ros-e2e
```

CIは参照node/Bridge lifecycle/観測のcheckと、全33ケースの`ROS 2 DDS, MQTT and dashboard fault E2E`を別jobにする。故障E2Eの結果とcleanupは失敗時もartifactへ保存する。入口未実行・中断・Docker構築失敗をROS成功へ読み替えない。通常の品質checkでskipされる画面E2Eも、専用jobでは必須のケースとして検証する。

実機の安全停止、安全認証、PX4、AI、large-scale性能は未検証。実AWSは#64の別範囲とし、この試験では使用・課金しない。環境別の実行結果と未確認事項はPRへ記録する。
