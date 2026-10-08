# telemetry保存の冪等化

## 保存と移行

v2 telemetryは`(device_id, session_id, sequence)`で重複排除する。単件・batch・同時受信ともPostgreSQLの部分一意インデックスとtransactionで判定する。同じ送信内容なら保存済みとして成功扱いにし、内容が異なれば警告して既存行を維持する。受信時刻とretain情報は送信内容の照合対象ではない。衝突したメッセージではdeviceの接続状態や最終受信時刻を更新しない。受信時刻が古い再送でも既存の最終受信時刻を過去へ戻さない。

`0002_true_santa_claus.sql`は既存行を削除・上書きしない。移行前のv2に同じ識別子の履歴が複数ある場合は、最小idの行を`identity_owner=true`の代表行とし、他の行は`false`で残す。内容の異なる既存重複でもこの規則を使う。以後の照合対象は代表行であり、移行前の重複履歴はAPIから引き続き参照できる。`session_id IS NOT NULL AND identity_owner`の行だけが一意制約の対象となる。旧v1行はsessionIdを持たず、従来どおり毎回保存する。

新しいv2行は元のtimestamp文字列とpayloadを`source_payload`（JSONB）にも保存する。これによりbatteryの`real`型への丸め前の値も比較できる。既存行には元JSONが残っていないため、timestampは保存済み時刻、batteryはfloat32の保存精度で照合する。既存行について失われた元精度の相違は検出できない。JSONのキー順や表記上の数値の差ではなく、検証後の各値を比較する。

## 件数の読み方

ingestorの計測モードでは次を分ける。

| カウンタ              | 意味                                                            |
| --------------------- | --------------------------------------------------------------- |
| `dbInserted`          | 新規保存したメッセージ数                                        |
| `telemetryDuplicates` | 同じ識別子・同じ内容で追加保存しなかった受信数                  |
| `telemetryConflicts`  | 同じ識別子・異なる内容の受信数                                  |
| `dbSaveSucceeded`     | 新規保存と内容一致の再受信を合わせた成功数                      |
| `dbSaveFailed`        | transaction失敗やbuffer上限などの保存失敗数。内容衝突は含めない |

負荷レポート集約は重複・衝突を合算する。旧schemaVersion 1レポートに新カウンタがなければ0として扱う。`dbPersisted`はDBの実保存行数であり、再受信成功数とは異なる。再送しない通常の負荷試験では送信成功・受信・保存成功・実保存件数の一致を検証し、内容衝突があれば失敗とする。再送試験では同じ識別子の受信を増やしても実保存件数が増えないことを別に検証する。既存の負荷試験結果は過去の計測値として変更しない。

## 検証と残る範囲

実PostgreSQLのintegration testで、同一batchの重複・衝突、同時受信、別sessionId、旧v1、既存重複行の移行、古い再送と衝突時のdevice更新を検証する。`DATABASE_INTEGRATION=true`とテスト専用DBの`POSTGRES_*`設定を指定し、`pnpm db:test:integration`および`pnpm telemetry:test:integration`を実行する。migrationは並列実行しない。

#112は受信側の保存冪等性だけを実装する。ingestorの保存確認receipt、simulatorの確認済み削除と全未確認行の再送は#128の対象であり、SQLiteからPostgreSQLへのat-least-once保存はまだ保証しない。
