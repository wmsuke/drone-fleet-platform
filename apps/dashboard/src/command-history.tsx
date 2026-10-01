import { useQuery } from "@tanstack/react-query";

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
};

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
      <dl className="command-history-details">
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
