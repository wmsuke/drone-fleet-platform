import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "./api.js";
import {
  fetchRosExecution,
  fetchRosCancel,
  requestRosCancel,
  type RosCancellation,
  type RosExecution,
} from "./ros-api.js";

const labels = {
  NOT_REPORTED: "実行未報告",
  RUNNING: "実行中",
  SUCCEEDED: "実行成功",
  FAILED: "実行失敗",
  UNCERTAIN: "実行結果不明",
  REJECTED: "実行拒否・未開始",
  CANCELLED: "実行中断の終端",
};
const phases = {
  REQUESTED: "中断要求を保存・端末受領は未確認",
  RECEIVED: "Bridgeが中断要求を受領",
  SEND_INTENT: "中断送信意図・応答未確認",
  ACCEPTED: "ROSが中断を受付（完了・停止ではない）",
  REJECTED: "ROSの中断受付なし",
  UNCERTAIN: "中断応答が不明",
};
const assessments = {
  PENDING: "中断結果を確認中",
  REJECTED: "中断要求は拒否",
  UNCERTAIN: "中断確認は不確定",
  CANCELLED: "実行中断の終端と停止観測あり",
  COMPLETED: "元の操作が実行成功",
  FAILED: "元の操作が実行失敗",
};
type Intent = { key: string; reason: string };
function loadIntent(key: string): Intent | null {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      v &&
      typeof v === "object" &&
      "key" in v &&
      "reason" in v &&
      typeof v.key === "string" &&
      typeof v.reason === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(v.reason)
    )
      return { key: v.key, reason: v.reason };
  } catch {
    /* 保存不能時は新規送信前に明示エラーにする。 */
  }
  return null;
}
function CancelControl({
  base,
  deviceId,
  commandId,
  execution,
  cancellation,
  unavailable,
}: {
  base: string;
  deviceId: string;
  commandId: string;
  execution: RosExecution;
  cancellation: RosCancellation | null;
  unavailable: boolean;
}) {
  const client = useQueryClient();
  const storageKey = `ros-cancel:${base}:${deviceId}:${commandId}`;
  const [intent, setIntent] = useState<Intent | null>(() =>
    loadIntent(storageKey),
  );
  const [reason, setReason] = useState(intent?.reason ?? "");
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    confirm = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (cancellation) resultHeading.current?.focus();
  }, [cancellation?.cancelId]);
  useEffect(() => {
    if (confirming) confirm.current?.focus();
  }, [confirming]);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const value = intent ?? { key: crypto.randomUUID(), reason };
      // 本文とkeyは送信前に保存し、応答喪失・再読込で別要求にしない。
      sessionStorage.setItem(storageKey, JSON.stringify(value));
      setIntent(value);
      return requestRosCancel(
        base,
        deviceId,
        commandId,
        value.key,
        value.reason,
      );
    },
    onSettled: () => {
      sending.current = false;
      void client.invalidateQueries({
        queryKey: ["ros-cancel", base, deviceId, commandId],
      });
      void client.invalidateQueries({
        queryKey: ["ros-execution", base, deviceId, commandId],
      });
      void client.invalidateQueries({ queryKey: ["commands", deviceId] });
    },
    onSuccess: () => setConfirming(false),
  });
  const component = execution.configuration.bridge;
  const canCancel =
    !unavailable &&
    !execution.target.conflicted &&
    execution.target.acceptedAt !== null &&
    execution.target.goalId !== null &&
    ["NOT_REPORTED", "RUNNING"].includes(execution.command.executionStatus) &&
    component.status === "KNOWN" &&
    ["0.4.0", "0.5.0"].includes(component.version);
  if (cancellation)
    return (
      <section aria-label="中断と介入履歴">
        <h4 ref={resultHeading} tabIndex={-1}>
          中断要求・介入
        </h4>
        <p>{phases[cancellation.phase]}</p>
        <p>{assessments[cancellation.assessment]}</p>
        <p>
          元の実行: {labels[cancellation.terminalStatus]} /{" "}
          {cancellation.stopConfirmation === "OBSERVED"
            ? "参照モデルの停止観測あり"
            : cancellation.stopConfirmation === "NOT_STARTED"
              ? "未開始"
              : "停止観測は未確認"}
        </p>
        {unavailable && (
          <p role="alert">
            中断状態の更新に失敗しました。表示は前回の記録です。
          </p>
        )}
        {cancellation.humanReviewRequired && (
          <p role="status">人間判断待ち。自動再投入は行いません。</p>
        )}
        <p>
          理由 {cancellation.request.reason} / 中断ID {cancellation.cancelId} /
          介入ID {cancellation.intervention.interventionId}
        </p>
        <p>
          操作者 {cancellation.intervention.actorKind}（本人認証なし）/ 開始{" "}
          {cancellation.intervention.startedAt} / 作業終了{" "}
          {cancellation.intervention.finishedAt ?? "未報告"} / 所要時間{" "}
          {cancellation.intervention.durationMs ?? "未報告"} / 費用{" "}
          {cancellation.intervention.cost === null
            ? "未報告"
            : JSON.stringify(cancellation.intervention.cost)}
        </p>
        <details>
          <summary>中断の結果根拠・採否・原文</summary>
          <pre className="ros-evidence">
            {JSON.stringify(cancellation.events, null, 2)}
          </pre>
        </details>
      </section>
    );
  return (
    <section aria-label="理由付き中断">
      <h4>理由付き中断</h4>
      <p>
        202は要求の保存だけです。ROS受付・実行終端・停止観測を別々に確認してください。
      </p>
      {!canCancel && (
        <p>
          対応goalが未確認・終端・不確定・旧version、または状態取得中のため中断を新規送信できません。
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canCancel && !sending.current) setConfirming(true);
        }}
      >
        <label>
          中断理由コード
          <input
            value={reason}
            required
            maxLength={64}
            pattern="[A-Z][A-Z0-9_]{0,63}"
            readOnly={!!intent || confirming}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby="ros-reason-help"
          />
        </label>
        <p id="ros-reason-help">
          英大文字で開始し、英大文字・数字・_を64文字以内。例 OPERATOR_REQUEST
        </p>
        <button
          ref={trigger}
          type="submit"
          disabled={
            !canCancel ||
            mutation.isPending ||
            !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason)
          }
        >
          {intent ? "同じ中断要求を再確認" : "中断内容を確認"}
        </button>
        {confirming && (
          <div
            role="dialog"
            aria-labelledby="ros-cancel-confirm"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !mutation.isPending) {
                setConfirming(false);
                trigger.current?.focus();
              }
            }}
          >
            <h4 id="ros-cancel-confirm">このgoalの中断を要求しますか？</h4>
            <p>
              {deviceId} / command {commandId} / goal {execution.target.goalId}{" "}
              / 理由 {reason}
            </p>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => {
                setConfirming(false);
                trigger.current?.focus();
              }}
            >
              戻る
            </button>
            <button
              ref={confirm}
              type="button"
              disabled={!canCancel || mutation.isPending}
              onClick={() => {
                if (!canCancel || sending.current) return;
                sending.current = true;
                mutation.mutate();
              }}
            >
              中断要求を送信
            </button>
          </div>
        )}
      </form>
      {mutation.isSuccess && (
        <p role="status">
          中断要求を保存しました。実行完了・停止は未確認です。
        </p>
      )}
      {mutation.isError && (
        <p role="alert">
          中断要求の確認に失敗しました。
          {mutation.error instanceof ApiError && mutation.error.status === 409
            ? "APIが状態競合を拒否しました。最新の証拠を確認してください。"
            : "応答なしを未送信とは判断できません。同じ理由・keyで再確認してください。保存できない場合は送信しません。"}
        </p>
      )}
    </section>
  );
}

export function RosExecutionDetails({
  base,
  deviceId,
  commandId,
}: {
  base: string;
  deviceId: string;
  commandId: string;
}) {
  const execution = useQuery({
    queryKey: ["ros-execution", base, deviceId, commandId],
    queryFn: ({ signal }) =>
      fetchRosExecution(base, deviceId, commandId, signal),
    refetchInterval: 5000,
    retry: false,
  });
  const cancellation = useQuery({
    queryKey: ["ros-cancel", base, deviceId, commandId],
    queryFn: ({ signal }) => fetchRosCancel(base, deviceId, commandId, signal),
    refetchInterval: 5000,
    retry: false,
  });
  const data = execution.data;
  return (
    <section aria-label="ROS実行の詳細">
      <h3>実行と中断: {commandId}</h3>
      <Link to={`/audit-logs?commandId=${encodeURIComponent(commandId)}`}>
        このcommandの監査ログ・介入記録
      </Link>
      {execution.isPending ? (
        <p role="status">実行証拠を読み込み中…</p>
      ) : execution.isError ? (
        <p role="alert">
          実行証拠を取得できません。表示は最新ではありません。
          <button onClick={() => void execution.refetch()}>
            実行証拠を再試行
          </button>
        </p>
      ) : data === null ? (
        <p>ROS実行の対応は未登録です。ACKからgoalや成功を補完しません。</p>
      ) : null}
      {data && (
        <>
          <p>配送・受領ACK: {data.command.status}（完了ではない）</p>
          <p>
            goal {data.target.goalId ?? "未確認"} / ROS受理{" "}
            {data.target.acceptedAt ?? "未確認"}
          </p>
          <p>
            実行結果: {labels[data.command.executionStatus]} / 元の結果期限{" "}
            {data.target.resultDeadline}
          </p>
          <p>
            {data.target.notStarted
              ? "実行未開始"
              : data.target.stopConfirmed
                ? "参照モデルの停止観測あり"
                : "停止観測は未確認"}
            。物理安全停止の保証ではありません。
          </p>
          {data.recovery.humanReviewRequired && (
            <p role="status">
              人間判断待ち: {data.recovery.reason} / 証拠{" "}
              {data.recovery.evidenceEventId ?? "なし"}
              。再接続だけで復旧済みにせず、自動再投入しません。
            </p>
          )}
          <h4>実行時の構成（現在の構成とは別）</h4>
          <p>
            server {data.configuration.serverInstanceId} / profile{" "}
            {data.configuration.profile.definition.profileId}{" "}
            {data.configuration.profile.definition.version}
          </p>
          <ul aria-label="実行進捗と結果根拠">
            {data.events.map((e) => (
              <li key={e.eventId}>
                {e.message.timestamp} / {e.message.kind} / {e.message.reason} /
                採否 {e.disposition}
                {e.message.kind === "FEEDBACK" && (
                  <span>
                    {" "}
                    距離 {e.message.distanceMm} mm（進捗であり成功ではない）
                  </span>
                )}
                <details>
                  <summary>証拠 {e.eventId}</summary>
                  <pre className="ros-evidence">
                    {JSON.stringify(e, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
          {cancellation.isError && (
            <p role="alert">
              中断状態を取得できません。
              <button onClick={() => void cancellation.refetch()}>
                中断状態を再試行
              </button>
            </p>
          )}
          <CancelControl
            base={base}
            deviceId={deviceId}
            commandId={commandId}
            execution={data}
            cancellation={cancellation.data ?? null}
            unavailable={
              execution.isError ||
              execution.isFetching ||
              cancellation.isPending ||
              cancellation.isError
            }
          />
        </>
      )}
    </section>
  );
}
