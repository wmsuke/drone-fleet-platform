import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  actionLabels,
  pendingSchema,
  sendIntent,
  OtaError,
  type Intent,
  type Pending,
} from "./ota-api.js";

export function useOtaRequest(base: string, done: (id: string) => void) {
  const storageKey = `ota-pending:${base}`;
  const [initial] = useState(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return {
        pending: raw === null ? null : pendingSchema.parse(JSON.parse(raw)),
        error: false,
      };
    } catch {
      return { pending: null, error: true };
    }
  });
  const [pending, setPending] = useState<Pending | null>(initial.pending),
    [storageError, setStorageError] = useState(initial.error),
    [notice, setNotice] = useState("");
  const sending = useRef(false);
  const mutation = useMutation({
    mutationFn: (p: Pending) => sendIntent(base, p),
    retry: false,
    onSuccess(result, saved) {
      clear();
      setNotice(
        result.status === "UNAVAILABLE"
          ? `復旧要求は拒否されました: ${result.failureReason}。回復成功ではありません。`
          : `${actionLabels[saved.intent.action]}を受け付けました。端末の停止・更新・回復成功は別途確認してください。`,
      );
      done(result.deploymentId);
    },
    onError(error) {
      // 形式の分かる4xx拒否以外は受付済みか不明。同じ要求を保持する。
      if (
        error instanceof OtaError &&
        error.code &&
        [400, 404, 409, 429].includes(error.status) &&
        error.code !== "IDEMPOTENCY_CONFLICT"
      )
        clear();
    },
    onSettled() {
      sending.current = false;
    },
  });
  function clear() {
    try {
      sessionStorage.removeItem(storageKey);
      setPending(null);
    } catch {
      setStorageError(true);
    }
  }
  function send(intent?: Intent) {
    if (sending.current || storageError) return;
    let saved = pending;
    try {
      if (!saved) {
        if (!intent || sessionStorage.getItem(storageKey) !== null)
          throw new Error("pending request changed");
        saved = pendingSchema.parse({
          version: 1,
          key: crypto.randomUUID(),
          intent,
        });
        sessionStorage.setItem(storageKey, JSON.stringify(saved));
        setPending(saved);
      }
      const current = pendingSchema.parse(
        JSON.parse(sessionStorage.getItem(storageKey)!),
      );
      if (JSON.stringify(current) !== JSON.stringify(saved))
        throw new Error("pending request changed");
    } catch {
      setStorageError(true);
      return;
    }
    setNotice("");
    sending.current = true;
    mutation.mutate(saved);
  }
  return {
    send,
    blocked: !!pending || storageError || mutation.isPending,
    panel: (
      <section aria-label="OTA操作の受付結果" className="ota-request">
        {storageError && (
          <p role="alert">
            要求の保存・復元に失敗しました。安全のため新しい操作を止めています。配信履歴とタブの保存領域を確認してください。
          </p>
        )}
        {pending && (
          <div>
            <p>
              受付確認待ち: {actionLabels[pending.intent.action]}
              。通信断でも受付済みの場合があります。新しい要求は作りません。
            </p>
            {"deploymentId" in pending.intent && (
              <Link to={`/deployments/${pending.intent.deploymentId}`}>
                対象の配信履歴
              </Link>
            )}
            <button
              type="button"
              onClick={() => send()}
              disabled={mutation.isPending || storageError}
            >
              {mutation.isPending ? "受付確認中…" : "同じ要求で受付を確認"}
            </button>
          </div>
        )}
        {mutation.isError && (
          <p role="alert">
            {mutation.error instanceof OtaError
              ? `HTTP ${mutation.error.status}: ${mutation.error.code ?? "応答不明"}`
              : "通信または応答形式のエラー"}
            。
            {pending
              ? "受付結果が不明です。同じ要求で確認してください。"
              : "要求は拒否されました。最新状態と理由を確認してください。"}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </section>
    ),
  };
}

export function OtaConfirmation({
  intent,
  summary,
  blocked,
  onCancel,
  onSubmit,
}: {
  intent: Intent;
  summary: React.ReactNode;
  blocked: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [checked, setChecked] = useState(false),
    cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <section
      className="command-confirmation"
      aria-label="OTA操作の最終確認"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <h3>{actionLabels[intent.action]}の最終確認</h3>
      {summary}
      {"reason" in intent.body && <p>理由コード: {intent.body.reason}</p>}
      <p>
        HTTP
        202は受付のみです。停止要求は停止確認ではなく、rollback要求は旧版の回復成功ではありません。操作者は本人未確認（anonymous）として介入を記録します。
      </p>
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        対象・段階・理由と操作の影響を確認した
      </label>
      {blocked && <p role="alert">{blocked}</p>}
      <div className="confirmation-actions">
        <button type="button" ref={cancel} onClick={onCancel}>
          確認をキャンセル
        </button>
        <button
          type="button"
          disabled={!checked || !!blocked}
          onClick={onSubmit}
        >
          確認した操作を送信
        </button>
      </div>
    </section>
  );
}
