# グループ操作・alert・audit logのE2E

Issue #147のローカル自動テスト。専用のPostgreSQL、Mosquitto、API、ingestor、simulator、alert/operation audit workerを起動し、dashboardのReact画面から実HTTPで操作する。API応答・repository・DB時計をmockしない。

```sh
pnpm install --frozen-lockfile
pnpm test:fleet-e2e
```

repository rootから実行する。通常の`.env`、Compose環境、AWS認証情報は使わない。APIとMQTTはloopbackの動的portへ公開し、UUID付きprojectで他の環境から分離する。全体のテスト上限は9分で、接続・送信・poll・Dockerコマンドにも上限を設ける。CIの独立した`Fleet operation, alert, and audit E2E`ジョブで実行し、通常の`pnpm check`ではskipする。

## 自動で確認する経路

1. simulator 1台とMQTT fixtureの4台を登録し、ONLINE/OFFLINEが混在するgroupを画面から作成・編集する。
2. 4台への帰還を確認付きで送信する。4つの異なるcommandとoutbox、受付時のtargetを実DBで照合する。
3. 実行中に1台をgroupから外し、別の1台を加える。既存operationのdeviceId・commandIdが変わらないことを確認する。
4. 同じidempotency keyで実APIへ再送し、operation 1件・target/command/outbox各4件のままであることを確認する。
5. 実simulatorの帰還成功、fixtureの実行失敗、期限拒否、未応答を同じoperationへ混在させる。対象ごとのAPI・画面表示とPARTIALLY_FAILEDを確認する。
6. command alertの発生を待ち、画面で未応答alertを確認する。確認してもACTIVEのままであることを確認する。
7. 未応答だったcommandの有効な開始時刻を持つ後着成功をMQTTで送る。alertがRESOLVEDへ変わり、確認時刻を保持し、operationも再集約されることを確認する。実行失敗・期限切れのalertは解除しない。
8. group作成・membership変更・operation受付/replay・alert確認/解除のauditを検索し、受付の重複がないことを確認する。画面からalert→監査一覧→監査詳細→operationへ移動する。

成功は本番simulatorの10秒の帰還処理を通す。他の3状態はproduction schemaで検証したMQTT fixtureの制御で再現し、DBの状態を直接書き換えない。期限切れは開始期限30秒を実時間で待ってREJECTED_EXPIREDを送る。未応答は受領ACKを返さず通常の再送・TIMED_OUTで評価する。後着成功のstartedAtは期限前の時刻を使う。結果確認期限120秒は短縮せず、このテストだけで120秒の結果未応答境界を検証済みとはしない。

alert/operation audit workerの周期だけを250msにして待機時間を抑える。発生条件・解除条件・commandの期限は変更しない。fixtureのMQTTはjsdomのbrowser条件に影響されないNode workerで実行する。これはローカル制御用の集約接続であり、AWSの機体単位clientId・証明書・IoT Policyを検証するものではない。

## 画面とブラウザの範囲

CIの画面操作はTesting Library＋jsdomで、全通信は本物のHTTP。ブラウザエンジン、CSSレイアウト、スクリーンリーダーはこの自動テストの対象外とする。実ブラウザの確認結果は別に記録し、jsdomを実ブラウザのE2Eとは呼ばない。

ローカルの確認用に`FLEET_E2E_INSPECT_MS=120000 pnpm test:fleet-e2e`を使うと、全検証が通過した後だけ最大2分間、専用APIを維持する。表示されたAPI URLを使って`VITE_API_BASE_URL=<URL> pnpm --filter @drone-fleet/dashboard dev --host 127.0.0.1 --port 15147 --strictPort`を別途起動し、`http://localhost:15147`から確認する。この保持もfinallyとshell trapの対象で、自動削除を無効化しない。別途起動したdev serverは確認後に停止する。

## ログと後処理

結果は`fleet-e2e-results/<project>/`に`result.json`、`commands.log`、`services.log`、shell側の`fallback-services.log`と`wrapper-cleanup.json`を保存する。resultはphase、シナリオのID・件数・状態、失敗理由、fixtureエラー、cleanupの結果を含む。CIでは成功・失敗ともartifactを14日保持する。

テストのfinallyでMQTT worker・heartbeatを閉じ、ログを保存してから専用container・volume・network・imageを削除し、Compose labelで残存を確認する。Vitestの失敗・中断でもshellのEXIT/INT/TERM trapが同じprojectだけを削除する。cleanup失敗は非0終了として隠さない。ホストやDocker自体の強制停止ではtrapが動かない場合があるため、残存project名を確認して復旧する。

`FLEET_E2E_FAIL_AT=after-start pnpm test:fleet-e2e`は起動直後に意図的に失敗させ、削除と診断記録を確認するための入口である。非0終了が期待値であり、通常のCI成功コマンドには指定しない。

## ローカルでの確認記録

2026-10-20、macOS 14.5 / OrbStack、ホストNode.js 24.21.0・pnpm 10.28.1、container Node.js 22・PostgreSQL 17・Mosquitto 2.0.22で実行した。[成功結果](fleet-e2e-result.json)にsnapshot、1 operation / 各4行、4状態の混在と後着成功後の再集約、alert確認・解除時刻、audit action、cleanup成功を残した。

実ブラウザでも同じ試行の結果→alert詳細（解除済み・確認済み）→監査ログへ移動した。[画面例](dashboard-fleet-e2e.jpg)では、後着成功のため配送TIMED_OUTと実行SUCCEEDEDが併存する機体も完了として表示されている。未応答を最終的な物理故障と断定しない規則を確認できる。通常チェックは689件成功、条件付き117件skip。AWSの実行結果は含めていない。

起動後の[意図した失敗の結果](fleet-e2e-cleanup-result.json)でも、失敗理由・サービスログ・commands.logを保存し、cleanup.success=true、fixtureエラー0、wrapperの終了コード1を確認した。container/volume/network/imageの残存はなかった。これは失敗経路の確認なので、E2E本体の成功件数へは加えない。

## AWSとの境界

このコマンドはローカル経路専用でAWSリソースを作成しない。mTLS、IoT Policy、実AWSの配送・費用は未確認としてresultへ明示する。AWSの小規模確認は[AWS IoT E2E](aws/README.md)と[#64の費用管理](load-testing/aws-iot-free-tier.md)に従って別に実施し、ローカル成功で代用しない。今回はAWSを実行しないため、AWSリソースの後処理対象もない。
