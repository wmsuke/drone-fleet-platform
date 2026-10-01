import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  ApiError,
  sendCommand,
  type CommandResponse,
  type CommandType,
} from "./api.js";

const commandLabels: Record<CommandType, string> = {
  RETURN_HOME: "帰還",
  REBOOT: "再起動",
};

export function CommandControls({
  apiBaseUrl,
  deviceId,
}: {
  apiBaseUrl: string;
  deviceId: string;
}) {
  const [selectedCommand, setSelectedCommand] = useState<CommandType | null>(
    null,
  );
  const [rebootAccepted, setRebootAccepted] = useState(false);
  const [lastCommand, setLastCommand] = useState<CommandResponse | null>(null);
  const sendingRef = useRef(false);
  const command = useMutation({
    mutationFn: (type: CommandType) => sendCommand(apiBaseUrl, deviceId, type),
    onSuccess(response) {
      setLastCommand(response);
      setSelectedCommand(null);
      setRebootAccepted(false);
    },
    onSettled() {
      sendingRef.current = false;
    },
  });

  const selectCommand = (type: CommandType) => {
    if (command.isPending) {
      return;
    }
    setLastCommand(null);
    command.reset();
    setRebootAccepted(false);
    setSelectedCommand(type);
  };

  const confirmCommand = () => {
    if (selectedCommand === null || sendingRef.current || command.isPending) {
      return;
    }
    if (selectedCommand === "REBOOT" && !rebootAccepted) {
      return;
    }
    sendingRef.current = true;
    command.mutate(selectedCommand);
  };

  return (
    <section className="command-section" aria-labelledby="command-title">
      <div className="section-heading">
        <div>
          <p className="device-label">Remote commands</p>
          <h3 id="command-title">コマンド操作</h3>
        </div>
      </div>
      <div className="command-actions">
        <button
          className="command-button command-return"
          disabled={command.isPending}
          type="button"
          onClick={() => selectCommand("RETURN_HOME")}
        >
          帰還させる
        </button>
        <button
          className="command-button command-reboot"
          disabled={command.isPending}
          type="button"
          onClick={() => selectCommand("REBOOT")}
        >
          再起動する
        </button>
      </div>

      {selectedCommand !== null && (
        <div
          className="command-confirmation"
          role="dialog"
          aria-labelledby="confirmation-title"
        >
          <strong id="confirmation-title">
            {commandLabels[selectedCommand]}コマンドを送信しますか？
          </strong>
          <p>
            対象機体: <code>{deviceId}</code>
          </p>
          {selectedCommand === "REBOOT" && (
            <label className="risk-confirmation">
              <input
                checked={rebootAccepted}
                disabled={command.isPending}
                type="checkbox"
                onChange={(event) => setRebootAccepted(event.target.checked)}
              />
              再起動により通信が一時切断されることを理解しました
            </label>
          )}
          <div className="confirmation-actions">
            <button
              type="button"
              disabled={command.isPending}
              onClick={() => setSelectedCommand(null)}
            >
              キャンセル
            </button>
            <button
              className="confirm-command"
              type="button"
              disabled={
                command.isPending ||
                (selectedCommand === "REBOOT" && !rebootAccepted)
              }
              onClick={confirmCommand}
            >
              {command.isPending
                ? "送信中…"
                : `${commandLabels[selectedCommand]}を実行`}
            </button>
          </div>
        </div>
      )}

      {lastCommand !== null && (
        <p className="command-result command-success" role="status">
          {commandLabels[lastCommand.type]}コマンドを送信しました。
          <span>状態: {lastCommand.status}</span>
        </p>
      )}
      {command.isError && (
        <p className="command-result command-error" role="alert">
          コマンドを送信できませんでした。
          <span>
            {command.error instanceof ApiError && command.error.status === 404
              ? "対象機体が登録されていません。"
              : "APIの状態を確認して、もう一度お試しください。"}
          </span>
        </p>
      )}
    </section>
  );
}
