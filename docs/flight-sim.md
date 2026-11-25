# 飛行シミュレータの起動試験

[ADR 0009](adr/0009-flight-simulation-task-evaluation-and-recovery.md)で選んだX3を、Gazebo Harmonic 8.15.0とROS 2 Jazzy / ros_gz 1.0.25で動かす。試験はLinuxコンテナ内で完結し、実機やAWS、ホストへのROS導入は不要。

```bash
bash scripts/test-flight-sim.sh
```

Dockerに4 vCPU、8 GiBメモリ、20 GiB空きを確保する。これはビルドを含む初期予算。GUIや描画センサーを使わないためGPUは不要。実行対象はLinux arm64/amd64で、CIはnative amd64を使う。初回ビルドは公式APTと固定資産の取得にネット接続が必要。

| シナリオ | 合格条件 |
| --- | --- |
| ascent-hover | ROSの速度指令で上昇し、odometryの高度が0.3 m超増える。指令停止後の速度は0.15 m/s未満。clockとodometryの時刻が進む。 |
| missing-odometry | clockと指令経路が動いた状態で、購読先の欠測により8秒のwall期限でREADY_TIMEOUTになる。 |

試験はseed 42、初期位置と基準home (0, 0, 1) m、1 ms物理stepを使う。homeはシナリオの基準点。起動ごとのworldInstanceIdとclockEpochを記録し、動作区間はsim時間、待ち上限はwall時間で測る。再実行には同じ定義を使うが、サンプル到着順や測定値の完全一致は要求しない。

結果ディレクトリにイメージID、CPU構成、パッケージ一覧、worldのSHA-256、観測、プロセス終了記録を保存する。各試行は外部ネットワークを持たないコンテナで動き、DDSはlocalhost、Gazebo Transportは試行固有のpartitionに閉じる。MQTTサービスは起動しない。終了時に専用コンテナと試験用イメージのタグを削除する。Dockerのビルドキャッシュは再利用する。

ベースOCIはdigest指定。arm64は#220の実測一覧、amd64は同ベースと公式APTで解決した完全版一覧を使い、導入後に全パッケージを照合する。固定版が配布元から消えた場合はビルドを失敗させる。上流world、X3モデル、生成済みworldをSHA-256で照合する。Fleet向けの帰還Action、電池・接触の証拠とTask評価は後続Issueで扱う。

## Fleetへの観測接続

```bash
bash scripts/test-flight-observations.sh
```

固定X3の3D odometryをROSで受け取り、既存Bridgeの観測契約に変換する。固定worldではGazeboのworld原点とFleetのLOCAL map原点、モデル原点とbase_linkがそれぞれ一致する。Gazeboの3D odometryはworld基準のposeと機体基準のtwistを出すため、この組に限定して変換する。入力frame・時刻表現・有限値を検証し、同じsim timestampをBridgeへ伝える。座標変換の根拠は[Gazebo OdometryPublisherの実装](https://github.com/gazebosim/gz-sim/blob/a7f89720bbcb1a5191e4eb53917fef048c26740c/src/systems/odometry_publisher/OdometryPublisher.cc)を参照。

専用Compose内でDDSはlocalhostに閉じ、BridgeのMQTTはその試験専用brokerへ接続する。APIへの到達試験ではLOCAL/ENUの位置と速度の単位、飛行中の高度変化、battery欠測を確認する。この経路は観測専用で、飛行指令は固定シナリオのROS入力から送る。
