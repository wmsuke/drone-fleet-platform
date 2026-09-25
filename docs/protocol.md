# 通信仕様

## 対象

シミュレータとFleet Platformの間で使うMQTTメッセージを定義する。

Phase 1では、テレメトリ、接続状態、コマンド、受領確認（ACK）を扱う。メッセージはUTF-8のJSONとし、型と検証処理を `packages/protocol` に置く。

## トピック

| トピック | 送信元 | 受信先 |
|---|---|---|
| `fleet/v1/devices/{deviceId}/telemetry` | デバイス | MQTT受信処理 |
| `fleet/v1/devices/{deviceId}/status` | デバイス・ブローカーのLWT | MQTT受信処理 |
| `fleet/v1/devices/{deviceId}/commands` | API | デバイス |
| `fleet/v1/devices/{deviceId}/command-acks` | デバイス | MQTT受信処理 |

`deviceId`は機体ごとに一意とする。使用できる文字は英数字、ハイフン、アンダースコアとし、1〜64文字に制限する。

トピックとメッセージ内のdeviceIdが一致しない場合は受け付けない。

## 配信設定

| メッセージ | QoS | retain |
|---|---:|---|
| テレメトリ | 0 | false |
| 接続状態 | 1 | true |
| コマンド | 1 | false |
| ACK | 1 | false |

Phase 1のテレメトリは欠損を許容する。通信断中の保存と再送はPhase 3で実装する。

コマンドはretainしない。Phase 1では永続セッションを使わず、オフライン中のコマンドを後から配送する機能は設けない。

QoS 1でも、操作が一度だけ実行されることや、ACKが必ず届くことは保証しない。

## 共通項目

| 項目 | 内容 |
|---|---|
| `schemaVersion` | この仕様では整数の `1` |
| `deviceId` | 対象デバイスのID |
| `timestamp` | メッセージ作成時刻。UTCのISO 8601形式 |

時刻の例は `2026-09-25T08:00:00.000Z`。

デバイスの時刻とサーバーの受信時刻は別に保存する。オンライン判定にはサーバーの受信時刻を使う。

互換性のない形式へ変更する場合は、トピックとschemaVersionのバージョンを更新する。

## テレメトリ

原則として5秒ごとに送信する。

```json
{
  "schemaVersion": 1,
  "deviceId": "drone-001",
  "sequence": 1234,
  "timestamp": "2026-09-25T08:00:00.000Z",
  "payload": {
    "battery": 78,
    "latitude": 35.4,
    "longitude": 139.6,
    "altitude": 32,
    "temperature": 48,
    "status": "FLYING"
  }
}
```

### 項目

| 項目 | 型・範囲 | 単位・意味 |
|---|---|---|
| `sequence` | 0以上の安全な整数 | デバイスごとの送信連番 |
| `battery` | 0〜100の数値 | % |
| `latitude` | -90〜90の数値 | 緯度、度 |
| `longitude` | -180〜180の数値 | 経度、度 |
| `altitude` | 0以上の有限数値 | シミュレータの離陸地点を基準とした高度、m |
| `temperature` | 有限数値 | シミュレータが生成する機体温度、℃ |
| `status` | 定義済みの文字列 | 飛行状態 |

位置はWGS 84の緯度・経度を使う。

Phase 1の飛行状態は次の3つとする。

- `IDLE`
- `FLYING`
- `RETURNING_HOME`

飛行状態と接続状態は区別する。通信が途絶えても、最後に受信した飛行状態は履歴として保持する。

### 連番

sequenceは起動時に0から始め、送信ごとに1増やす。MQTTの再接続ではリセットしない。

プロセスの再起動では0に戻るため、Phase 1ではdeviceIdとsequenceを一意キーにしない。再送時の重複排除に必要なセッション識別はPhase 3で追加する。

## 接続状態

```json
{
  "schemaVersion": 1,
  "deviceId": "drone-001",
  "timestamp": "2026-09-25T08:00:00.000Z",
  "payload": {
    "status": "ONLINE",
    "reason": "CONNECTED"
  }
}
```

| status | reason | 用途 |
|---|---|---|
| `ONLINE` | `CONNECTED` | 接続完了 |
| `OFFLINE` | `SHUTDOWN` | 正常終了 |
| `OFFLINE` | `CONNECTION_LOST` | LWTによる切断通知 |

### 接続・切断時の処理

- 接続時に、OFFLINE / CONNECTION_LOSTをLWTとして設定する。
- 接続が完了したら、ONLINE / CONNECTEDをretain付きで送信する。
- 正常終了時は、OFFLINE / SHUTDOWNを送信してから切断する。
- 予期しない切断はLWTで通知する。

LWTのtimestampは接続時に作成した値であり、実際の切断時刻ではない。切断通知を受け取った時刻は、サーバー側で別に記録する。

### オンライン判定

初期のタイムアウトは15秒とし、設定で変更できるようにする。

- 通常配信のONLINEまたはテレメトリを受信したら、最終受信時刻を更新する。
- OFFLINEを受信したらオフラインにする。
- 最終受信から15秒以上経過した場合もオフラインにする。
- その後、新しいONLINEまたはテレメトリを受信したらオンラインへ戻す。

購読開始時に再配信されたretainedメッセージだけでは、オンラインと確定しない。現在の接続を示す新しい通知かテレメトリを待つ。

## コマンド

```json
{
  "schemaVersion": 1,
  "commandId": "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
  "deviceId": "drone-001",
  "type": "RETURN_HOME",
  "timestamp": "2026-09-25T08:00:00.000Z"
}
```

| 項目 | 内容 |
|---|---|
| `commandId` | APIが発行するUUID |
| `type` | `RETURN_HOME` または `REBOOT` |

### シミュレータの動作

- `RETURN_HOME`：ACKを送信し、飛行状態をRETURNING_HOMEへ変更する。
- `REBOOT`：ACKを送信した後に正常切断し、模擬的な再起動を行う。再接続後はONLINEを通知する。

飛行や再起動の完了通知はPhase 1に含めない。

### 重複受信

同じcommandIdを再受信した場合は、操作を繰り返さずACKを再送する。

Phase 1の処理済みcommandIdはメモリで保持する。再起動後も重複実行を防ぐための永続化はPhase 3で扱う。

## ACK

```json
{
  "schemaVersion": 1,
  "commandId": "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
  "deviceId": "drone-001",
  "status": "ACKNOWLEDGED",
  "timestamp": "2026-09-25T08:00:01.000Z"
}
```

ACKは、有効なコマンドを受け付けたことを示す。操作の成功や完了を意味しない。

受信側は、commandIdとdeviceIdが保存済みのコマンドに一致することを確認する。不明なコマンドへのACKは状態更新に使わず、ログに残す。

## コマンドの管理状態

以下はDBとAPIで扱う状態であり、すべてがMQTTメッセージとして送られるわけではない。

| 状態 | 意味 |
|---|---|
| `PENDING` | DBへ記録済み、送信待ち |
| `SENT` | ブローカーへの送信を確認した |
| `ACKNOWLEDGED` | デバイスから受領確認が届いた |
| `FAILED` | 送信処理でエラーを検出した |
| `TIMED_OUT` | ACK待ちの期限を過ぎた |

正常系はPENDING → SENT → ACKNOWLEDGEDとする。

ACK待ちの期限は、初期設定でコマンド作成から30秒とする。期限を過ぎても有効なACKが届いた場合はACKNOWLEDGEDへ更新し、期限超過の記録を残す。

ACKが送信結果のDB更新より先に届く場合もあるため、ACKNOWLEDGEDを後からSENTへ戻さない。

Phase 1では自動再送を行わない。FAILEDやTIMED_OUTは、デバイスが操作していないことの証明にはならない。

## 入力検証

受信時は、少なくとも以下を確認する。

- JSONとして解釈できる。
- schemaVersionが対応範囲内である。
- 必須項目、型、値の範囲が正しい。
- トピックと本文のdeviceIdが一致する。
- コマンドや状態の値が定義済みである。

不正なメッセージは処理せず、原因をログに残す。受信処理全体は停止させない。

同じバージョン内の拡張を許容するため、未知の追加フィールドは無視する。必須フィールドの意味を変更する場合はバージョンを上げる。

## Phase 1の制約

- テレメトリの欠損や重複を完全には防がない。
- 通信断中のデータを保存・再送しない。
- コマンドの実行完了は追跡しない。
- コマンドの重複実行防止はプロセスの稼働中に限る。
- DB保存とMQTT送信の間の障害に対する自動復旧は行わない。
- MQTT上のdeviceId照合だけでは送信者を認証できない。個体認証と権限制御はPhase 2で追加する。

通信断対応を追加するときは、セッション識別、永続バッファ、再送、重複排除、コマンドの有効期限を見直す。
