# ROS commandの送信境界

Issue #194の実装途中の契約とjournal。API受付・Action呼出し・実行結果のPostgreSQL保存はまだ接続しておらず、Bridgeの操作readyはfalseを維持する。以下をROS commandの動作済みE2Eとして扱わない。

## 通信契約

`packages/protocol`の`rosCommandMessageSchema`で専用command v3を定義する。`RETURN_HOME`、`targetKind=ROS2`、構成snapshotの`expectedConfigurationId`、受付UTCから30秒の`expiresAt`、120秒の`resultDeadline`を必須にする。未知のActionやREBOOTを受け付けない。Python向けJSON Schemaを同じ定義から生成する。JSON Schemaへ変換されない期限の相関検証はPythonでも行う。

既存`commandMessageSchema`はv1/v2のままにする。v3をsimulatorへ配送せず、APIのROS受付もまだ有効化しない。受領ACK v2のDB側scope拡張は後続の配送接続時に行う。

Bridgeは自機の`commands`へ届いたv3を検証し、本文と受領ACK v2を同じSQLite transactionでcommitした後でMQTT受領を確定する。30秒の開始期限以上では`REJECTED_EXPIRED`、期限内では`ACKNOWLEDGED`とする。これは受領の事実だけであり、構成適合・ROS availability・Action受付を意味しない。ROS未接続でも保存できるが、操作readyはfalseのままでgoalを作らない。古いv1/v2 command、別device、期限相関違反、不正本文にはcommand ACKを生成しない。

ACKは永続pending queueからQoS 1・retainなしで送る。PUBACKではpendingだけを解除し、本文と元ACKの正本を残す。同commandId/同canonical本文の再配送では期限後・Bridge再起動後も元のtimestamp/statusで再通知する。別本文では正本を変えずACKを返さない。ACK v2にはDB receiptがないため、PUBACKはDB保存証明ではなく、DB保存までの保証を改善したとは扱わない。

期限拒否の受領記録は、その後の時計逆行で開始可能時刻へ戻っても実行準備を禁止する。受領済み本文と異なるcommandからgoal対応を作ることも拒否する。

## SQLiteの不変対応

SQLite user_version 4で`action_commands`、現在のuser_version 5で`command_receipts`を非破壊追加する。受領本文/ACKも重要記録の容量へ合算する。既存の構成・telemetry・receipt・owner lockは維持する。`CommandJournal`は既存journalと同じowner thread、同じWAL/synchronous FULL接続を使う。

新規commandは端末・構成digest・既知能力・許可Action・開始期限を検証し、本文のcanonical SHA-256、commandId、一度だけ生成するgoal UUID、構成snapshotをREADYとしてcommitする。同commandId・同本文では元の対応を返し、期限後や再起動後も新UUIDへ差し替えない。同ID・別本文は拒否する。

SendGoal前にSEND_INTENTを別commitする。READY以外から送信意図を作れず、開始期限も再検証する。再起動時はSEND_INTENT/ACCEPTED/RUNNINGをUNCERTAINへ移し、保存UUIDの結果照会候補にする。再送候補にはしない。READYは送信意図前として残す。

明示goal拒否はREJECTEDとして保存し、startedAtを作らない。REJECTED以外は次の新規goalを拒否する。終端結果があっても停止確認を伴わずに排他解除しない。commandと構成snapshotも既存の重要記録10,000件/32 MiBに合算し、満杯では削除せず失敗する。

## 未接続の範囲

- APIのROS対象選択・OTA/排他gate、受領ACK v2のDB側ROS scope照合
- runtime heartbeat、Action送信、feedback/結果の検証
- 保存UUIDによるGetResult再照会、server世代・cache期限の照合
- bridge-eventの実行証拠、DB保存receipt、PostgreSQLへの投影
- REJECTED/CANCELLEDを含むAPI・複数機体集約・表示の対応
- 実Action serverの成功・拒否・失敗と送信前後停止をDBまで追うE2E

この範囲が揃うまでIssue #194を完了扱いにせず、操作受付を有効化しない。cancel操作は引き続きIssue #195の対象とする。

受領経路の試験では、実Mosquittoと別processのBridgeを使い、ACK到着時点でSQLiteへ正本が見えること、SIGKILL後の同本文再配送で元ACKを通知すること、goalが一件も生成されないことを確認する。この受領復旧試験は実Actionの送信境界・GetResult・DBまでのE2Eを代替しない。
