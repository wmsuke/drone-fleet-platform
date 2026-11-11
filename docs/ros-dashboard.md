# ROS観測・実行・中断の画面

Issue #197。機体詳細の「ROS観測・実行・理由付き中断を追跡」から `/devices/:deviceId/ros` を開く。command履歴からも元commandを指定して開ける。`?commandId=UUID`を含むURLで再読込しても同じ実行を追跡する。simulatorの従来画面は維持する。

## 表示と受付

- 最新構成とhealth、観測、command履歴、選択した実行と中断を5秒ごとに取得する。取得失敗は前回値と区別し、読み取りを再試行できる。構成未報告・古いhealth・取得失敗時は新規commandを許可しない。
- MQTT接続/購読、ROS到達性、観測鮮度、機体の拒否理由、未解決goal、照会回数、元期限、欠損/保持上限を分ける。ONLINEや再接続だけでready・停止成功を作らない。
- Bridge/Adapter/profile version、構成ID・server世代・namespace、期待構成との一致と対応操作を示す。構成報告以下の連番のhealthもreadyへ使わない。画面で非対応のREBOOT等を無効にし、APIのcapability/排他/鮮度検証も維持する。
- ROS観測の送信・DB受信・ROS受信時刻、stamp/timeDomain/clockEpoch、品質理由を表示する。3秒以上古い観測、欠測、無効値を現在値として扱わない。取得失敗時も新鮮と表示しない。
- LOCALはENUのx/y/z・mとframe、速度のframeとm/s・rad/sを示し、緯度/経度へ変換しない。GEODETICはWGS84楕円体基準を明示する。null・UNKNOWNは不明のまま、診断のlevelと省略も表示する。

構成/health/観測は既存APIを使い、通信本文は`packages/protocol`のschemaで検証する。HTTP応答の型・device/command対応も検証し、不正値を成功表示へ補完しない。現在の構成と、commandに固定された実行時構成は別表示にする。

## 実行・中断・介入

配送/受領ACK、goal受理、feedback、実行未報告/実行中/成功/失敗/拒否/中断/不確定、停止観測を分ける。feedbackの距離は進捗であり成功ではない。採否付きeventとCDR/hash等の原文を展開でき、command単位のauditへ移動できる。不確定・停止未確認の人間判断要求を表示し、自動再投入・安全未確認の予約解除を設けない。

理由付き中断は既存の`POST /devices/:deviceId/commands/:commandId/cancel`へ送る。英大文字で始まる64文字以内の理由コードを入力し、device/command/goal/理由の確認後だけ送信する。対応goal未確認・不確定・終端・旧versionや取得失敗では新規送信しない。通信断中でもAPIが認める既知goalの中断受付は妨げず、結果は別途確認する。

本文とIdempotency-Keyを送信前にsessionStorageへ保存する。応答喪失では新しいkeyを作らず、同一タブの再読込後も保存した理由/keyで明示的に再確認する。保存不能時は送信しない。自動的なPOST再試行は行わない。既存中断がGETで得られれば新規入力を表示せず、その履歴を追跡する。別タブ/保存消去に対してはAPIの1command1中断制約が正本となる。

202は要求保存、ROS ACCEPTEDは中断受付だけで、CANCELLED・停止成功ではない。終端と参照モデルの停止観測、人間判断、介入ID/理由/開始、actorKindを別表示する。本人認証はなく、作業終了・所要時間・費用のnullは未報告と表示する。参照モデルの停止観測を実機の物理安全停止へ読み替えない。

## 操作・検証の境界

見出し・ラベル付き入力・native button/select/detailsを使う。確認時は送信buttonへfocusを移し、Escapeまたは「戻る」で確認を取り消して元buttonへ戻す。中断履歴が得られたら結果見出しへ移す。通信失敗はalert、受付/人間判断はstatusで示し、色だけで状態を区別しない。

dashboardの振る舞いテストでfresh/unknown/失効、frame/単位、進捗、理由付き確認、keyboard focus、通信失敗・再読込・同一keyを検証する。PostgreSQL統合ではHTTP応答と画面のschemaの互換性、capability非対応のAPI拒否、中断の理由保存と再取得を確認する。実DDSの配送・停止保証を画面mockから主張しない。Phase全体の実ROS画面E2Eは#198、実機の安全認証・操作者認証は対象外とする。
