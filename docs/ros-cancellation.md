# ROS 2 Actionの中断と停止観測

Issue #195。[ADR 0008](adr/0008-ros2-bridge-contract-and-recovery.md)に従い、中断要求、配送、ROS受付/拒否、実行終端、停止観測を分離する。対象は参照ReturnHome Action。中断受付だけではCANCELLEDにも物理停止確定にもしない。

## APIと介入記録

`POST /devices/:deviceId/commands/:commandId/cancel`へ`Idempotency-Key`と`{"reason":"OPERATOR_REQUEST"}`を送る。理由は英大文字から始まる64文字以内のコード。未知項目・操作者指定は拒否する。202は永続受付だけを表す。同じcommand/key/理由は同じcancelId・対象・元期限を返し、別理由は409 IDEMPOTENCY_CONFLICT、別keyは409 CANCEL_ALREADY_REQUESTEDとする。1commandに1要求とし、再送予算を新keyで戻さない。

APIはdevice lockの下で、保存済みcommand/goal UUID・受付時構成・server世代・実goal受付を固定する。対応不明/SEND_INTENT不明/実行不確定は409 GOAL_UNCONFIRMED、確定終端は409 GOAL_ALREADY_TERMINAL。中断のためにgoalを作らない。既存要求の再確認は終端後や期限後も可能。中断はBridge 0.4.0を必要とし、旧0.3.0の新規要求は409 ROS_CANCEL_UPGRADE_REQUIREDとする。

`ros_command_cancels`が中断要求とその人間介入の正本である。cancelId、interventionId、対象、理由、作成UTC、HTTP requestId、actorKind=anonymous/actorId=nullを同じtransactionで保存する。`command.cancel_requested/replayed/sent/changed`のauditをcommandIdとinterventionIdで関連付ける。本人認証はなく、クライアントのactor headerを採用しない。GETのinterventionは保存済み情報から返し、人間の作業終了・所要時間・費用は未報告のnullとする。OTA専用の介入記録へ混在させない。

## 通信・永続配送

`fleet/v1/devices/{deviceId}/bridge-requests`、QoS 1、retainなし。schemaVersion 1、kind=CANCEL_COMMAND、requestId=cancelId、deviceId/commandId/goalId/configurationId/serverInstanceId、timestamp/expiresAt、reasonを必須とする。型・検証はpackages/protocolを正とし、PythonへJSON Schemaと共通fixtureを生成する。期限とIDの相関はPythonでも検証する。QUERY_COMMAND_STATEは今回追加せず、Bridge内部のGetResult照会を使う。

APIは受付時刻から10秒以内、最大3回まで同じ本文を配送する。試行数は送信前に保存し、送信例外・worker再起動で戻さない。PUBACKは配送の事実であり中断確認ではない。Bridgeからの受領証拠が保存されれば配送を止める。接続待ち・publishも元期限で打ち切る。

SQLite schema 7のcancel_requestsへ本文hash、元期限、状態、ROS送信回数、送信意図UTC、応答eventを保存する。自機・既存goal・固定構成を検証してから受領をcommitし、その後MQTTへPUBACKする。不正本文、別device、同ID別本文、未知対応は隔離し、実行候補にしない。同本文の再配送は元eventを再通知するだけで、新たな中断を送らない。履歴・未確認eventを既存の10,000件/32 MiB上限へ合算し、満杯でも捨てない。

ROSには特定goal UUIDとzero timestampだけを送る。zero UUIDや時刻以前の全goalを対象にしない。[CancelGoalの公式契約](https://github.com/ros2/rcl_interfaces/blob/jazzy/action_msgs/srv/CancelGoal.srv)に従い、return_code=0かつgoals_cancelingに対象UUIDがある場合だけACCEPTEDとする。ROS送信意図と回数も呼出し前にcommitし、元10秒以内・最大3回に制限する。応答待ちは2秒ごとに評価し、遅延futureを上限付きで保持して後着の証拠を残す。未確認SEND_INTENTから再起動した場合はUNCERTAINを残し、元goalのGetResultへ移り、同要求を無条件再発行しない。

CANCEL eventはRECEIVED / SEND_INTENT / ACCEPTED / REJECTED / UNCERTAINを区別する。応答のROS code・対象一覧・CDR原文・SHA-256、ID・時刻・試行を保存する。bridge_cancel_eventsの正本・採否・受信UTCをPostgreSQLへcommitした後だけbridge-receiptを返す。PUBACKで端末の重要eventを削除しない。別本文・不正scope・期限後の証拠は正本を変更せず、それぞれ衝突・UNMATCHED・LATEとして扱う。

固定Jazzyの[rclpy実装](https://github.com/ros2/rclpy/blob/jazzy/rclpy/rclpy/action/server.py)は、callback拒否や完了競合で対象を一覧から除いてもreturn_code=0を残す場合がある。実コンテナの同処理も確認した。この0＋空一覧はREJECTED / NO_GOAL_CANCELING（受付対象なし）とし、codeを1へ捏造せず原文を保存する。callback拒否か完了競合かはこの応答だけで断定せず、元goalの結果で照合する。未知codeや他goal一覧等の不正応答はUNCERTAINとし、可能な範囲で原文hash/byte数を残す。

## 終端・停止・不確定

`GET /devices/:deviceId/commands/:commandId/cancel`は要求phase、評価assessment、元commandのterminalStatus、stopConfirmation、humanReviewRequired、介入参照と採否付きeventを返す。

| 証拠 | 扱い |
| --- | --- |
| HTTP 202、MQTT PUBACK、ROS ACCEPTED | 要求/配送/中断受付。commandの実行終端を変更しない |
| ROS REJECTED / UNKNOWN_GOAL / ALREADY_TERMINAL | 応答codeを残し、元UUIDのGetResultへ進む。停止を推定しない |
| 実result CANCELED | 元commandをCANCELLEDとして保存する。停止観測は別に確認する |
| 実result SUCCEEDED | 前後の中断要求や応答で消去しない。停止観測も揃えば評価COMPLETED |
| 実result ABORTED | FAILEDを保持し、中断成功へ読み替えない |
| 10秒以内に終端と必要な停止が揃わない、切断、送信後再起動、矛盾 | 中断確認UNCERTAIN・人間判断待ち。後着応答で元の期限内確認へ書き換えない |

停止観測は#194の同server/goal/config、終端後5秒以内、freshなIDLEと速度0.05 m/s以下の1秒継続を使う。中断responseではこの条件を緩めない。停止未確認/実行不確定の排他を時間だけで解除しない。参照モデルの停止観測であり、実機の物理安全停止の証明ではない。

通常command履歴の画面にも、要求受付・中断評価・停止未確認/観測・人間判断待ちと介入IDを別表示する。中断の送信操作は今回HTTP APIとし、ROS専用の操作画面は#197の範囲とする。

## 更新・検証

中断ケースだけを確認する場合は`ROS_COMMANDS_CASES=cancel corepack pnpm test:ros-commands`を使う。CIでは指定せず、通常Actionも含めて実行する。

command受付停止→migration 0024→protocol/ingestor/API/中断worker→Bridge 0.4.0の順に更新する。Adapter/interfacesは0.3.0のまま、Profile 1.1.0を維持する。旧構成・結果の読み取りとsimulator command v1/v2/ACK v1/v2/v3は維持する。旧Bridgeへ中断topicを配送しない。

AWS用Terraformには自機bridge-requestsのsubscribe/receiveとAPIのpublishだけを追加する。deviceの他機体権限は増やさない。Policyを受信側と先に揃える。今回はmock providerの検証だけで、実AWSの適用・実機検証は行わない。

`corepack pnpm test:ros-bridge`で永続化・共通契約・重複・容量・再起動・遅着を検証する。`corepack pnpm test:ros-commands`は実DDS/Mosquitto/PostgreSQL/APIで中断受付とCANCELLED/停止の分離、拒否後の成功、遅延中断と成功の競合、受付後終端なし、通信断/再起動/期限後配送、実UNKNOWN_GOALを検証する。通常Actionの成功/拒否/失敗・SIGKILL・GetResult・simulator共存も再実行する。各参照processは10台以内の設定を切り替え、結果・証拠・cleanupを一時ディレクトリへ保存し、専用container/volume/imageを削除する。
