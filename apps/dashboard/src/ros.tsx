import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { fetchCommandHistory } from "./api.js";
import {
  fetchRosConfiguration,
  fetchRosHealth,
  fetchRosObservations,
} from "./ros-api.js";
import { RosObservationDetails } from "./ros-observation.js";
import { RosExecutionDetails } from "./ros-execution.js";
import { CommandControls } from "./command-controls.js";

export function RosPage({ apiBaseUrl }: { apiBaseUrl: string | null }) {
  const { deviceId = "" } = useParams();
  return (
    <section className="panel ros-panel" aria-labelledby="ros-title">
      <h2 id="ros-title">ROS状態・操作 {deviceId}</h2>
      <Link to={`/devices/${encodeURIComponent(deviceId)}`}>
        機体詳細へ戻る
      </Link>
      {apiBaseUrl === null ? (
        <p role="alert">API接続先が設定されていません。</p>
      ) : (
        <RosDevice
          key={`${apiBaseUrl}:${deviceId}`}
          base={apiBaseUrl}
          deviceId={deviceId}
        />
      )}
    </section>
  );
}
function RosDevice({ base, deviceId }: { base: string; deviceId: string }) {
  const [params, setParams] = useSearchParams();
  const commandId = params.get("commandId");
  const options = { refetchInterval: 5000, retry: false as const };
  const config = useQuery({
    ...options,
    queryKey: ["ros-configuration", base, deviceId],
    queryFn: ({ signal }) => fetchRosConfiguration(base, deviceId, signal),
  });
  const health = useQuery({
    ...options,
    queryKey: ["ros-health", base, deviceId],
    queryFn: ({ signal }) => fetchRosHealth(base, deviceId, signal),
  });
  const observations = useQuery({
    ...options,
    queryKey: ["ros-observations", base, deviceId],
    queryFn: ({ signal }) => fetchRosObservations(base, deviceId, signal),
  });
  const history = useQuery({
    ...options,
    queryKey: ["commands", deviceId],
    queryFn: ({ signal }) => fetchCommandHistory(base, deviceId, signal),
  });
  const configuration = config.data?.reported;
  const h = health.data?.latest;
  const fresh = (time: string) =>
    Date.now() >= Date.parse(time) && Date.now() - Date.parse(time) < 15000;
  const usable =
    !config.isError &&
    !health.isError &&
    !config.isFetching &&
    !health.isFetching &&
    !!configuration &&
    config.data?.fresh &&
    config.data.ready &&
    health.data?.fresh &&
    health.data.ready &&
    !!h &&
    fresh(configuration.receivedAt) &&
    fresh(h.receivedAt) &&
    fresh(h.message.timestamp) &&
    h.message.configurationId === configuration.configurationId &&
    h.message.sequence > configuration.reportSequence;
  const operations =
    config.isError || !configuration || !config.data?.fresh
      ? []
      : config.data.supportedOperations.filter(
          (v): v is "RETURN_HOME" | "REBOOT" =>
            v === "RETURN_HOME" || v === "REBOOT",
        );
  return (
    <div className="detail-content">
      <p>
        5秒ごとに更新。MQTTオンライン、ROS到達性、観測鮮度、実行終端、停止観測は別の状態です。
      </p>
      <Link to={`/audit-logs?targetId=${encodeURIComponent(deviceId)}`}>
        機体の監査ログ
      </Link>
      {config.isPending || health.isPending ? (
        <p role="status">ROS構成・接続を読み込み中…</p>
      ) : null}
      {config.isError || health.isError ? (
        <p role="alert">
          ROS構成・接続を取得できません。操作を許可せず、前回値は参考表示にします。
          <button
            onClick={() => {
              void config.refetch();
              void health.refetch();
            }}
          >
            ROS接続を再試行
          </button>
        </p>
      ) : null}
      <section aria-label="ROS接続と構成">
        <h3>接続・構成・能力</h3>
        <p>
          新規操作: {usable ? "受付可能（APIでも再検証）" : "不可・未確認"} /
          理由 {config.data?.operationReason ?? "未取得"}
        </p>
        {!configuration ? (
          <p>構成は未報告です。capabilityを推測しません。</p>
        ) : (
          <>
            <p>
              構成の鮮度:{" "}
              {config.data?.fresh &&
              fresh(configuration.receivedAt) &&
              !config.isError
                ? "新鮮"
                : "古い・取得失敗"}{" "}
              / 期待構成との一致:{" "}
              {config.data?.matchesDesired === null
                ? "期待構成未指定"
                : config.data?.matchesDesired
                  ? "一致"
                  : "不一致"}
            </p>
            <p>
              Bridge{" "}
              {configuration.configuration.bridge.status === "KNOWN"
                ? configuration.configuration.bridge.version
                : "不明"}{" "}
              / Adapter{" "}
              {configuration.configuration.adapter.status === "KNOWN"
                ? configuration.configuration.adapter.version
                : "不明"}{" "}
              / profile{" "}
              {configuration.configuration.profile.definition.profileId}{" "}
              {configuration.configuration.profile.definition.version}
            </p>
            <p>
              構成ID <code>{configuration.configurationId}</code> / report
              sequence {configuration.reportSequence} / server{" "}
              <code>{configuration.configuration.serverInstanceId}</code> /
              namespace {configuration.configuration.namespace}
            </p>
            <p>
              対応操作: {config.data?.supportedOperations.join(", ") || "なし"}
              。非対応操作は送信できません。参照ROSのREBOOTはnode再起動へ変換しません。
            </p>
          </>
        )}
        {!h ? (
          <p>healthは未受信です。</p>
        ) : (
          <>
            <p>
              health:{" "}
              {health.data?.fresh &&
              fresh(h.receivedAt) &&
              fresh(h.message.timestamp) &&
              !health.isError
                ? "新鮮"
                : "古い・取得失敗"}{" "}
              / 採否 {h.disposition} / {h.message.reason}
            </p>
            <p>
              MQTT接続 {h.message.mqttConnected ? "接続" : "未接続"} / 購読{" "}
              {h.message.mqttSubscribed ? "完了" : "未確認"} / ROS到達性{" "}
              {h.message.rosAvailable ? "到達（記録時点）" : "未到達"} / 観測{" "}
              {h.message.observationsFresh ? "新鮮（記録時点）" : "古い・欠測"}
            </p>
            <p>
              機体理由 {h.message.adapterReason ?? "不明"} / telemetry欠損{" "}
              {h.message.telemetryDropped} / 記録上限 {h.message.recordLimit}{" "}
              件・{h.message.byteLimit} bytes
            </p>
            {h.message.pendingGoal && (
              <p>
                未解決goal {h.message.pendingGoal.goalId} /{" "}
                {h.message.pendingGoal.state} / 再照会{" "}
                {h.message.pendingGoal.queryCount} 回 / 期限{" "}
                {h.message.pendingGoal.resultDeadline}
              </p>
            )}
            {health.data?.humanReviewRequired && (
              <p role="status">
                人間判断待ち。通信復帰を停止成功へ読み替えません。
              </p>
            )}
          </>
        )}
        <details>
          <summary>接続履歴・採否・結果根拠</summary>
          <pre className="ros-evidence">
            {JSON.stringify(health.data?.events ?? [], null, 2)}
          </pre>
        </details>
      </section>
      <CommandControls
        apiBaseUrl={base}
        deviceId={deviceId}
        supportedOperations={operations}
        blockedReason={
          usable ? undefined : "ROS構成・health・排他条件が未確認です。"
        }
      />
      {observations.isError ? (
        <p role="alert">
          ROS観測を取得できません。前回値は現在値として使わないでください。
          <button onClick={() => void observations.refetch()}>
            ROS観測を再試行
          </button>
        </p>
      ) : observations.isPending ? (
        <p role="status">ROS観測を読み込み中…</p>
      ) : null}
      {observations.data && (
        <RosObservationDetails
          observation={observations.data?.[0] ?? null}
          unavailable={observations.isError}
        />
      )}
      <section aria-label="ROS command選択">
        <h3>実行履歴</h3>
        {history.isPending && <p role="status">command履歴を読み込み中…</p>}
        {history.isError ? (
          <p role="alert">
            履歴を取得できません。
            <button onClick={() => void history.refetch()}>履歴を再試行</button>
          </p>
        ) : null}
        <label>
          追跡するcommand
          <select
            value={commandId ?? ""}
            onChange={(e) =>
              setParams(e.target.value ? { commandId: e.target.value } : {})
            }
          >
            <option value="">commandを選択</option>
            {commandId &&
              !history.data?.some((c) => c.commandId === commandId) && (
                <option value={commandId}>
                  {commandId}（URL指定・履歴範囲外）
                </option>
              )}
            {history.data?.map((c) => (
              <option key={c.commandId} value={c.commandId}>
                {c.type} / {c.commandId} / ACK {c.status} / 実行{" "}
                {c.executionStatus ?? "未報告"}
              </option>
            ))}
          </select>
        </label>
        {history.data?.length === 0 && <p>command履歴はありません。</p>}
      </section>
      {commandId && (
        <RosExecutionDetails
          key={commandId}
          base={base}
          deviceId={deviceId}
          commandId={commandId}
        />
      )}
    </div>
  );
}
