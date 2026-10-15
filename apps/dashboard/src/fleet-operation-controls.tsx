import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, type DeviceListItem, type CommandType } from "./api.js";
import type { Group } from "./groups-api.js";
import { fetchOperations, sendOperation } from "./fleet-operations-api.js";

interface Preview {
  groupId: string;
  name: string;
  revision: number;
  type: CommandType;
  total: number;
  online: number;
  offline: number;
  unknown: number;
}
interface Pending {
  groupId: string;
  type: CommandType;
  key: string;
}
const storageKey = (base: string, id: string) =>
  `fleet-operation-pending:${base}:${id}`;
function load(base: string, id: string): Pending | null {
  const raw = sessionStorage.getItem(storageKey(base, id));
  if (raw === null) return null;
  const v = JSON.parse(raw) as Pending;
  if (
    !v ||
    v.groupId !== id ||
    !["REBOOT", "RETURN_HOME"].includes(v.type) ||
    typeof v.key !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v.key)
  )
    throw new Error("invalid saved request");
  return v;
}
export function FleetOperationControls({
  base,
  groupId,
  group,
  devices,
  disabled,
}: {
  base: string;
  groupId: string;
  group?: Group;
  devices: Map<string, DeviceListItem> | null;
  disabled: boolean;
}) {
  const navigate = useNavigate();
  const [saved] = useState(() => {
    try {
      return { pending: load(base, groupId), error: false };
    } catch {
      return { pending: null, error: true };
    }
  });
  const [pending, setPending] = useState<Pending | null>(saved.pending);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [storageError, setStorageError] = useState(saved.error);
  const sending = useRef(false),
    cancel = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const active = useQuery({
    queryKey: ["fleet-active", base, groupId],
    queryFn: async ({ signal }) => {
      const [accepted, running] = await Promise.all([
        fetchOperations(base, { groupId, status: "ACCEPTED" }, signal),
        fetchOperations(base, { groupId, status: "IN_PROGRESS" }, signal),
      ]);
      return accepted.total + running.total;
    },
    enabled: preview !== null,
    retry: false,
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: (value: Pending) => sendOperation(base, value),
    retry: false,
    onSuccess(result) {
      // 削除失敗でも同じkeyの再照会は安全なので、成功したoperationの追跡を優先する。
      try {
        sessionStorage.removeItem(storageKey(base, groupId));
      } catch {
        /* 同じ要求が残るだけ */
      }
      navigate(`/fleet-operations/${result.operationId}`);
    },
    onSettled() {
      sending.current = false;
    },
  });
  useEffect(() => {
    if (preview) cancel.current?.focus();
  }, [preview]);
  const changed = !!preview && (!group || group.revision !== preview.revision);
  const close = () => {
    if (!sending.current) {
      setPreview(null);
      setConfirmed(false);
      heading.current?.focus();
    }
  };
  const select = (type: CommandType) => {
    if (!group || !devices || pending) return;
    const online = group.deviceIds.filter(
      (id) => devices.get(id)?.connectionStatus === "ONLINE",
    ).length;
    const offline = group.deviceIds.filter(
      (id) => devices.get(id)?.connectionStatus === "OFFLINE",
    ).length;
    setPreview({
      groupId,
      name: group.name,
      revision: group.revision,
      type,
      total: group.deviceCount,
      online,
      offline,
      unknown: group.deviceCount - online - offline,
    });
    setConfirmed(false);
    mutation.reset();
  };
  const submit = () => {
    if (sending.current || storageError) return;
    if (
      !pending &&
      (!preview ||
        !confirmed ||
        changed ||
        disabled ||
        active.isPending ||
        active.isFetching)
    )
      return;
    let request = pending;
    try {
      if (!request) {
        request = { groupId, type: preview!.type, key: crypto.randomUUID() };
        sessionStorage.setItem(
          storageKey(base, groupId),
          JSON.stringify(request),
        );
        setPending(request);
      }
      // 別の画面で保存内容が変わったときも新しいkeyで上書きして再実行しない。
      const stored = load(base, groupId);
      if (!stored || stored.key !== request.key || stored.type !== request.type)
        throw new Error("saved request changed");
    } catch {
      setStorageError(true);
      return;
    }
    sending.current = true;
    mutation.mutate(request);
  };
  return (
    <section className="command-section" aria-labelledby="fleet-send-title">
      <h3 id="fleet-send-title" tabIndex={-1} ref={heading}>
        グループ全体へのコマンド
      </h3>
      <p>単一機体への操作ではありません。OFFLINEの機体も対象に含みます。</p>
      <Link to={`/fleet-operations?groupId=${encodeURIComponent(groupId)}`}>
        このグループの操作履歴
      </Link>
      {storageError && (
        <p role="alert">
          送信要求を安全に保存・復元できません。自動送信は行いません。操作履歴を確認し、このタブの保存領域を確認してください。
        </p>
      )}
      {pending ? (
        <div className="command-confirmation" aria-label="受付確認待ちの要求">
          <p>
            受付確認待ち: {pending.type === "REBOOT" ? "再起動" : "帰還"}
            。通信エラーでも受付済みの場合があります。新しい操作を作らず、保存済みの同じ要求で受付結果を確認します。
          </p>
          <p>
            構成が変わっていても新しい対象への操作は作り直しません。未受付なら、再送時の構成で初めて受け付けられる場合があります。
          </p>
          <button
            type="button"
            disabled={mutation.isPending || storageError}
            onClick={submit}
          >
            {mutation.isPending ? "受付を確認中…" : "同じ要求で受付を確認"}
          </button>
        </div>
      ) : (
        <div className="command-actions">
          <button
            className="command-button command-return"
            type="button"
            disabled={
              disabled ||
              !devices ||
              !group?.deviceCount ||
              storageError ||
              preview !== null
            }
            onClick={() => select("RETURN_HOME")}
          >
            全機体への帰還を確認
          </button>
          <button
            className="command-button command-reboot"
            type="button"
            disabled={
              disabled ||
              !devices ||
              !group?.deviceCount ||
              storageError ||
              preview !== null
            }
            onClick={() => select("REBOOT")}
          >
            全機体への再起動を確認
          </button>
        </div>
      )}
      {preview && !pending && (
        <div
          role="dialog"
          aria-labelledby="fleet-confirm-title"
          className="command-confirmation"
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <h4 id="fleet-confirm-title">
            「{preview.name}」の全{preview.total}台へ
            {preview.type === "REBOOT" ? "再起動" : "帰還"}を送信しますか？
          </h4>
          <p>
            ONLINE {preview.online}台 / OFFLINE {preview.offline}台 / 状態未取得{" "}
            {preview.unknown}台
          </p>
          <p>
            表示は確認時のプレビューです。最終対象と台数はAPI受付時の構成で確定します。受付後の構成変更では対象は変わりません。
          </p>
          <p>
            同時開始・全件成功は保証されず、受付後はキャンセルできません。受領は実行完了ではありません。再起動は通信を切断します。
          </p>
          <p>
            {active.isPending
              ? "未終端のグループ操作を確認中…"
              : active.isError
                ? "進行中の操作を確認できません。重複操作の可能性があります。"
                : `このグループの未終端操作: ${active.data ?? 0}件。`}{" "}
            別グループや単一機体の未終端command、操作順序はこの確認では保証できません。
          </p>
          {changed && (
            <p role="alert">
              確認中に構成が変わりました。キャンセルして最新の対象を確認してください。
            </p>
          )}
          <label className="risk-confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            全機体への操作・OFFLINE機体の配送待ち・重複操作と切断のリスクを確認した
          </label>
          <div className="confirmation-actions">
            <button ref={cancel} type="button" onClick={close}>
              送信をキャンセル
            </button>
            <button
              type="button"
              disabled={
                !confirmed ||
                changed ||
                disabled ||
                storageError ||
                active.isPending ||
                active.isFetching
              }
              onClick={submit}
            >
              確認したグループ全体へ送信
            </button>
          </div>
        </div>
      )}
      {mutation.isError && (
        <p role="alert">
          受付結果を確認できませんでした（
          {mutation.error instanceof ApiError
            ? `HTTP ${mutation.error.status}`
            : "通信または応答形式のエラー"}
          ）。受付済みの可能性があるため、同じ要求で確認してください。
        </p>
      )}
    </section>
  );
}
