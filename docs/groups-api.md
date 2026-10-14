# 機体グループAPI

#137でgroupとmembershipの管理、#138で管理画面を追加した。複数機体command・audit logはまだない。設計は[ADR 0006](adr/0006-fleet-operations-alerts-and-audit.md)に従う。

## ダッシュボード

ナビゲーションの「機体グループ」から`/groups`を開く。一覧でgroupを作成し、名前のリンクから`/groups/:groupId`へ移動すると名称変更・削除と機体の追加・所属解除を行える。すべての変更は確認してから送信する。削除は機体そのものや過去の操作対象を削除しないことを確認画面で説明する。

groupとdevice一覧は5秒ごとに更新する。所属台数とONLINE / OFFLINE内訳はgroupのdeviceIdsをdevice一覧と照合して計算する。API未取得・一覧にない機体は「状態未取得」とし、OFFLINEへ推測しない。グループ一覧、所属一覧、追加候補は50件単位で表示し、機体ID検索は全件から絞り込む。現APIは全件取得なので、通信量・メモリ使用量まで50件に制限する方式ではない。

送信中は変更と確認ボタンを無効化し、成功・失敗を表示する。409等の失敗時にはgroupを再取得して確認を閉じる。「最新状態を再取得」でもgroupとdeviceの両方を更新でき、再実行は最新の表示から選び直して確認する。通信失敗でもサーバーでは変更済みの可能性があるため、作成を無条件に自動再試行しない。

入力にはlabelを付け、確認時はキャンセルへフォーカスを移す。Escapeまたはキャンセルで確認を閉じ、完了・キャンセル後は見出しへ戻す。リンク、入力、送信・確認・ページ切替は標準のキーボード操作を使う。UIテストで操作・エラー・フォーカス・展開件数と既存画面への回帰を確認する。

## エンドポイント

| Method | Path | 入力 | 成功 |
| --- | --- | --- | --- |
| POST | `/groups` | `{ "name": "訓練隊", "description": "格納庫A" }` | 201、group |
| GET | `/groups` | なし | 200、group配列 |
| GET | `/groups/:groupId` | UUID | 200、group |
| PATCH | `/groups/:groupId` | name、descriptionの一方または両方 | 200、group |
| DELETE | `/groups/:groupId` | UUID | 204、本文なし |
| POST | `/groups/:groupId/devices` | `{ "deviceId": "drone-001" }` | 201、更新後group |
| DELETE | `/groups/:groupId/devices/:deviceId` | UUIDとdeviceId | 204、本文なし |

nameは前後の空白を除去し、1〜100文字、制御文字なしとする。descriptionは省略またはnull可、最大1000文字でNULは拒否する。PATCHは空オブジェクトを拒否し、nullで説明を削除できる。未知の入力項目を拒否する。deviceIdは既存の英数字・ハイフン・アンダースコア1〜64文字規則を使う。名前の重複は許可し、識別にはgroupIdを使う。

返却例:

```json
{
  "groupId": "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55",
  "name": "訓練隊",
  "description": null,
  "revision": 2,
  "createdAt": "2026-10-13T00:00:00.000Z",
  "updatedAt": "2026-10-13T00:01:00.000Z",
  "deviceCount": 1,
  "deviceIds": ["drone-001"]
}
```

一覧は作成時刻・groupId順、deviceIdsはdeviceId順で返す。deviceCountとdeviceIdsは同じDB queryの結果から作り、空groupは0と空配列で返す。deviceの状態・telemetryは既存device APIで取得する。今回の一覧はpaginationなしで全件取得する。

## エラー

- 400: 不正なID・name・description・body、空PATCH
- 404: 存在しない、または論理削除済みgroup、存在しないdevice、削除対象membershipなし
- 409: 同じgroupへの同じdeviceの重複登録
- 500: DB障害など。成功した変更として扱わない

1台を複数groupに所属させられる。同じmembershipへの同時追加は一方のみ成功し、他方は409。変更・削除・membership操作はtransaction内でgroup行をロックしてrevisionを1進める。拒否した操作はrevisionを変更しない。PATCHは直列化されるが、楽観ロックの前提revisionは受け取らず、同じ項目は最後にcommitした値になる。

## 削除と履歴

DELETEはdeletedAtを設定し、group行とその時点のmembershipを残す。通常の一覧・詳細では非表示にし、以後の変更と再削除は404。membershipの個別削除は現在の所属だけを外し、deviceやcommand履歴を削除しない。外部キーはgroup・deviceの物理削除を制限する。

fleet operationは#139で追加するため、今回のgroup削除で操作履歴を実証したとは扱わない。後続では固定済みtargetと受付時のgroup名を正本とし、groupやmembershipからcascade削除しない。成功auditとの同時commitは#144で組み込む予定で、現時点で監査記録や認証済み操作者の保証はない。APIはローカルまたは制限したネットワークで使う。

## 検証

`pnpm check`で入力・HTTP応答を検証する。専用PostgreSQLの`POSTGRES_*`と`DATABASE_INTEGRATION=true`を設定し、`pnpm api:test:integration`でmigration、DB制約、同時追加・更新、拒否時rollback、論理削除後の保持、既存device APIを確認する。CIも同じAPI結合試験を実行する。
