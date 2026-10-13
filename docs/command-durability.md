# コマンドの期限と永続的な重複防止

## 通信と状態

APIは`schemaVersion=2`のcommandを送り、作成時刻から30秒後の`expiresAt`をPostgreSQLとメッセージへ記録する。期限は受領や完了の締切ではなく、操作開始の締切である。`now >= expiresAt`なら操作しない。topicは従来のcommands / command-acksを使い、localとAWSの処理を共通にする。

v2 ACKの`ACKNOWLEDGED`は受領を示し、実行完了を示さない。`REJECTED_EXPIRED`は、この受信または復旧時に期限のため操作を開始しなかったことを示す。APIは後者を`EXPIRED`として表示する。受領済みでも開始前に期限へ達した場合は期限切れに更新する。後から受領ACKが来ても`EXPIRED`を戻さず、受領ACK受信時刻だけを補う。送信結果の更新も`EXPIRED`や`ACKNOWLEDGED`を上書きしない。

履歴APIはv2行の`expiresAt`と、期限切れ通知があれば`expiredAt`を返す。既存v1行は期限を捏造せず、両項目を持たない。ダッシュボードは操作開始期限・期限切れを受領確認やACK待ちタイムアウトと分けて表示する。

## SQLiteと停止境界

simulatorは機体のtelemetryと同じSQLiteファイルの`command_history`へ、command本文、受信時刻、受領時刻、期限、操作試行・結果時刻、ACKと送信待ち状態を保存する。識別子は機体と正規化したcommandIdである。同じIDで内容が違う場合は警告して拒否し、既存記録を上書きしない。

| 停止した境界 | 復旧時の扱い |
| --- | --- |
| 受領記録のcommit前 | 記録がない。再配送があれば受領から始める |
| `RECEIVED`のcommit後、操作開始前 | 開始直前に期限を再確認し、期限内だけ開始する |
| `STARTED`のcommit後、結果のcommit前 | 結果を`UNCERTAIN`として履歴とログに残し、自動再実行しない |
| `COMPLETED`または`EXPIRED`のcommit後 | 同じIDでは操作せず、保存済みACKを再送する |
| ACK送信中・PUBACK前 | ACKを残して再送する。操作は繰り返さない |
| ACKのPUBACK後 | ACK送信待ちを解除する。command履歴は残す |

操作の直前に`STARTED`をcommitする。開始済み操作は期限だけで取り消さない。実際の操作とSQLiteのcommitは原子的にできないため、開始記録の直後に停止した場合は、操作が行われていなくても自動再試行しない。exactly-once実行や機体操作の完了を保証するものではない。

ACKは独立してQoS 1・retainなしで送信し、PUBACKを待たずに操作する。送信失敗・切断・タイムアウトではSQLiteに残し、再接続・再起動後に保存済みACKを再送する。遅れた古いACKのPUBACKで、新しい期限切れACKの送信待ちを解除しない。再試行は既存の`TELEMETRY_RETRY_BASE_MS` / `TELEMETRY_RETRY_MAX_MS`、速度の下限は`TELEMETRY_REPLAY_INTERVAL_MS`、PUBACK待ち上限は`TELEMETRY_PUBLISH_TIMEOUT_MS`を使う。

ACKのPUBACKはingestorによるDB更新を保証しない。DBが停止している間にACKを失うと、APIが`TIMED_OUT`のままの場合がある。同じcommandの再配送時はACKを再送するが、API outboxによる自動再送は#114で扱う。

## 履歴上限と端末時刻

- `COMMAND_HISTORY_RETENTION_MS`: 期限からの保持期間。既定7日（604800000ミリ秒）。次のcommand受信時に古い終端履歴を削除する。
- `COMMAND_HISTORY_MAX_ROWS`: 機体ごとの件数上限。既定10,000件。満杯なら期限切れの古い終端履歴から削除する。期限内・受領後未開始・開始中の履歴を消さなければ収まらない場合は新規受領を拒否し、ログへ残す。
- `COMMAND_CLOCK_TRUSTED`: UTC時刻の同期を運用側で確認できている前提。既定`true`。`false`では新規受領と未開始操作を拒否し、telemetryは継続する。既に保存済みのACKは再送できる。

容量到達時は保持期間より早く期限切れ履歴を消すことがある。履歴を消したIDも期限を過ぎているので新たに実行しない。ただし、再受信への期限切れACKは、削除済みの過去の操作が一度も行われなかった証明ではない。

期限判定は端末のUTC時刻に依存する。時刻が進んでいると早く拒否し、遅れていると本来の期限を過ぎても開始し得る。NTPなどでAPIと端末の時刻を同期し、ずれが期限の30秒に対して無視できることを確認する。実装は同一プロセス内の時刻巻き戻りを検知して拒否するが、OSの同期状態や再起動をまたぐずれを自動判定しない。確認できない場合は`COMMAND_CLOCK_TRUSTED=false`を使う。

SQLiteの故障・手動削除は履歴を失わせる。保存エラー時は操作を開始せず、開始済みで結果保存に失敗した場合も開始記録から自動再実行しない。volumeを保持して更新する。

## 移行と検証

PostgreSQL migrationは`EXPIRED`とnullableな期限・期限切れ通知時刻を追加する。既存v1 commandは期限なしのまま残し、旧v1 ACKもその行に限って受け付ける。v1 ACKでv2行を更新せず、v2 ACKでv1行も更新しない。

protocolの読み取りはv1/v2を残すが、新しいsimulatorは期限なしのv1 commandの新規受領を拒否する。今回はAPIと受信側をv2へ一括更新する。更新中はcommand受付を止め、migrationとingestor・simulator・APIの更新が揃ってから再開する。古いAPIを新しいsimulatorと混在させない。ローリング更新用のv1 command実行互換モードは設けない。

unit testでは期限の直前・境界・直後、受領後停止、開始後停止、結果保存後再起動、内容衝突、履歴上限・保持期間、時刻不信・巻き戻り、ACK失敗を検証する。実SQLite・MQTT・PostgreSQLのintegration testではAPIから送信し、プロセス再起動後の再配送で操作せずACKだけを返すことと、旧v1・新v2のACK分離、期限切れ後の遅延ACKを確認する。テスト専用DBの`POSTGRES_*`と`DATABASE_INTEGRATION=true`を指定して`pnpm telemetry:test:integration`と`pnpm api:test:integration`を実行する。Dockerが必要で、CIでも実行する。

実AWS環境の更新・通信試験はこの実装では行っていない。認証・topic・IoT Policyは既存のものを使い、継続負荷や新しいAWSリソースは追加しない。
