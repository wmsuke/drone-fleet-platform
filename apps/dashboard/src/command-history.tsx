import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import {
  ApiError,
  fetchCommandHistory,
  type CommandHistoryItem,
  type CommandStatus,
  type CommandType,
} from "./api.js";

export const COMMAND_HISTORY_REFRESH_INTERVAL_MS = 5_000;

const commandLabels: Record<CommandType, string> = {
  RETURN_HOME: "帰還",
  REBOOT: "再起動",
};

const statusLabels: Record<CommandStatus, string> = {
  PENDING: "送信待ち",
  SENT: "送信済み・ACK待ち",
  ACKNOWLEDGED: "ACK受信済み",
  FAILED: "送信失敗",
  TIMED_OUT: "ACK待ちタイムアウト",
  EXPIRED: "操作開始期限切れ",
};
const executionLabels = {
  NOT_REPORTED: "実行未報告",
  RUNNING: "実行中",
  SUCCEEDED: "実行成功",
  FAILED: "実行失敗",
  UNCERTAIN: "実行結果不明",
  REJECTED: "実行拒否（未開始）",
  CANCELLED: "実行中断",
} as const;
const cancelLabels = {
  REQUESTED: "中断要求を保存（端末受領は未確認）",
  RECEIVED: "中断要求をBridgeが受領",
  SEND_INTENT: "ROSへの中断送信意図を記録（送信結果は未確認）",
  ACCEPTED: "ROSが中断を受付（終端・停止は未確定）",
  REJECTED: "ROSの中断受付なし（理由は証拠で確認）",
  UNCERTAIN: "中断応答が不明",
} as const;
const cancelAssessments = {
  PENDING: "中断結果を確認中",
  REJECTED: "中断要求は拒否",
  UNCERTAIN: "中断確認は不確定",
  CANCELLED: "実行中断の終端と停止観測あり",
  COMPLETED: "元の操作が実行成功",
  FAILED: "元の操作が実行失敗",
} as const;

function formatTimestamp(value: string | null): string {
  if (value === null) {
    return "未受信";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function CommandHistoryRow({ command }: { command: CommandHistoryItem }) {
  return (
    <li className="command-history-item">
      <div className="command-history-summary">
        <strong>{commandLabels[command.type]}</strong>
        <span className={`command-status command-status-${command.status}`}>
          {statusLabels[command.status]}
        </span>
      </div>
      {command.executionStatus !== undefined && (
        <p>
          {executionLabels[command.executionStatus]}
          （ACK・停止確認とは別の状態）
        </p>
      )}
      {command.cancellation && (
        <div aria-label="中断の状態">
          <p>{cancelLabels[command.cancellation.phase]}</p>
          <p>
            {cancelAssessments[command.cancellation.assessment]}
            {command.cancellation.humanReviewRequired && "・人間判断待ち"}
          </p>
          <p>
            {command.cancellation.stopConfirmation === "OBSERVED"
              ? "参照モデルの停止観測あり（物理安全停止の保証ではない）"
              : command.cancellation.stopConfirmation === "NOT_STARTED"
                ? "実行未開始"
                : "停止観測は未確認"}
          </p>
          <p>
            介入ID {command.cancellation.interventionId} / 中断ID{" "}
            {command.cancellation.cancelId}
          </p>
        </div>
      )}
      <p>
        <Link to={`/audit-logs?commandId=${command.commandId}`}>
          監査ログ {command.commandId}
        </Link>
      </p>
      <dl className="command-history-details">
        {command.expiredAt !== undefined && (
          <div>
            <dt>期限切れ通知時刻</dt>
            <dd>
              <time dateTime={command.expiredAt}>
                {formatTimestamp(command.expiredAt)}
              </time>
            </dd>
          </div>
        )}
        {command.expiresAt !== undefined && (
          <div>
            <dt>操作開始期限</dt>
            <dd>
              <time dateTime={command.expiresAt}>
                {formatTimestamp(command.expiresAt)}
              </time>
            </dd>
          </div>
        )}
        <div>
          <dt>作成時刻</dt>
          <dd>
            <time dateTime={command.createdAt}>
              {formatTimestamp(command.createdAt)}
            </time>
          </dd>
        </div>
        <div>
          <dt>ACK受信時刻</dt>
          <dd>
            {command.acknowledgementReceivedAt === null ? (
              "未受信"
            ) : (
              <time dateTime={command.acknowledgementReceivedAt}>
                {formatTimestamp(command.acknowledgementReceivedAt)}
              </time>
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function CommandHistory({
  apiBaseUrl,
  deviceId,
}: {
  apiBaseUrl: string;
  deviceId: string;
}) {
  const history = useQuery({
    queryKey: ["commands", deviceId],
    queryFn: ({ signal }) => fetchCommandHistory(apiBaseUrl, deviceId, signal),
    refetchInterval: COMMAND_HISTORY_REFRESH_INTERVAL_MS,
    retry: false,
  });

  return (
    <section
      className="command-history"
      aria-labelledby="command-history-title"
    >
      <div className="section-heading">
        <div>
          <p className="device-label">Command history</p>
          <h3 id="command-history-title">コマンド履歴</h3>
        </div>
        <span className="sequence-label">5秒ごとに更新</span>
      </div>

      {history.isPending ? (
        <p className="notice">コマンド履歴を読み込んでいます…</p>
      ) : history.isError ? (
        <div className="notice notice-error" role="alert">
          <strong>コマンド履歴を取得できませんでした。</strong>
          <span>
            {history.error instanceof ApiError && history.error.status === 404
              ? "対象機体が登録されていません。"
              : "APIの起動状態を確認して、もう一度お試しください。"}
          </span>
          <button type="button" onClick={() => void history.refetch()}>
            再試行
          </button>
        </div>
      ) : history.data.length === 0 ? (
        <div className="empty-state">
          <strong>コマンド履歴はまだありません。</strong>
          <span>コマンドを送信すると、ここに状態が表示されます。</span>
        </div>
      ) : (
        <ul className="command-history-list">
          {history.data.map((command) => (
            <CommandHistoryRow command={command} key={command.commandId} />
          ))}
        </ul>
      )}
    </section>
  );
}
