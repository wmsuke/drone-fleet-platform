import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, fetchDevices, type DeviceListItem } from "./api.js";
import {
  fetchGroup,
  fetchGroups,
  mutateGroup,
  type Group,
  type GroupAction,
} from "./groups-api.js";

const PAGE_SIZE = 50;
function PagedList<T>({
  items,
  label,
  render,
}: {
  items: T[];
  label: string;
  render: (item: T) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return (
    <section aria-label={label}>
      <ul className="group-items">
        {items
          .slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
          .map(render)}
      </ul>
      {pages > 1 && (
        <div className="confirmation-actions">
          <button
            type="button"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            前へ
          </button>
          <span role="status">
            {current + 1} / {pages}ページ
          </span>
          <button
            type="button"
            disabled={current + 1 === pages}
            onClick={() => setPage(current + 1)}
          >
            次へ
          </button>
        </div>
      )}
    </section>
  );
}
function counts(group: Group, devices: Map<string, DeviceListItem> | null) {
  let online = 0,
    offline = 0;
  for (const id of group.deviceIds) {
    if (devices?.get(id)?.connectionStatus === "ONLINE") online++;
    if (devices?.get(id)?.connectionStatus === "OFFLINE") offline++;
  }
  return `所属 ${group.deviceCount}台 / ONLINE ${online}台 / OFFLINE ${offline}台 / 状態未取得 ${group.deviceCount - online - offline}台`;
}
function actionText(action: GroupAction) {
  switch (action.type) {
    case "create":
      return `「${action.name}」を作成`;
    case "rename":
      return `名称を「${action.name}」へ変更`;
    case "delete":
      return `「${action.name}」を削除`;
    case "add":
      return `${action.deviceId}を追加`;
    case "remove":
      return `${action.deviceId}の所属を解除`;
  }
}
export function GroupsPage({ apiBaseUrl }: { apiBaseUrl: string | null }) {
  const { groupId } = useParams();
  if (apiBaseUrl === null)
    return (
      <section className="panel">
        <h2>機体グループ</h2>
        <p role="alert">
          API接続先が設定されていません。VITE_API_BASE_URLを設定してください。
        </p>
      </section>
    );
  return (
    <ConnectedGroups
      key={`${apiBaseUrl}:${groupId ?? "list"}`}
      base={apiBaseUrl}
      groupId={groupId}
    />
  );
}
function ConnectedGroups({
  base,
  groupId,
}: {
  base: string;
  groupId?: string;
}) {
  const client = useQueryClient(),
    navigate = useNavigate();
  const location = useLocation();
  const heading = useRef<HTMLHeadingElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);
  const [name, setName] = useState(""),
    [search, setSearch] = useState("");
  const [confirmation, setConfirmation] = useState<GroupAction | null>(null);
  const [message, setMessage] = useState<string>(() => {
    const value = location.state as { groupMessage?: unknown } | null;
    return typeof value?.groupMessage === "string" ? value.groupMessage : "";
  });
  const [refreshError, setRefreshError] = useState(false);
  useEffect(() => {
    if (location.state?.groupMessage) heading.current?.focus();
  }, [location.state]);
  const groups = useQuery({
    queryKey: ["groups", base],
    queryFn: ({ signal }) => fetchGroups(base, signal),
    enabled: groupId === undefined,
    retry: false,
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: ["groups", base, groupId],
    queryFn: ({ signal }) => fetchGroup(base, groupId!, signal),
    enabled: groupId !== undefined,
    retry: false,
    refetchInterval: 5000,
  });
  const devices = useQuery({
    queryKey: ["group-devices", base],
    queryFn: ({ signal }) => fetchDevices(base, signal),
    retry: false,
    refetchInterval: 5000,
  });
  const active = groupId === undefined ? groups : detail;
  const deviceMap = devices.isSuccess
    ? new Map(devices.data.map((item) => [item.deviceId, item]))
    : null;
  const refresh = async () => {
    setRefreshError(false);
    const results = await Promise.all([active.refetch(), devices.refetch()]);
    if (results.some((result) => result.isError)) setRefreshError(true);
  };
  const mutation = useMutation({
    mutationFn: (action: GroupAction) => mutateGroup(base, action),
    async onSuccess(_, action) {
      setMessage(`${actionText(action)}しました。`);
      setConfirmation(null);
      setName("");
      await client.invalidateQueries({ queryKey: ["groups", base] });
      if (action.type === "delete")
        navigate("/groups", {
          state: { groupMessage: `${actionText(action)}しました。` },
        });
      else heading.current?.focus();
    },
    async onError() {
      await client.invalidateQueries({ queryKey: ["groups", base] });
      setConfirmation(null);
      heading.current?.focus();
    },
    onSettled() {
      sending.current = false;
    },
  });
  useEffect(() => {
    if (confirmation) cancel.current?.focus();
  }, [confirmation]);
  const select = (action: GroupAction) => {
    mutation.reset();
    setMessage("");
    setConfirmation(action);
  };
  const busy = mutation.isPending || confirmation !== null;
  const nameValid =
    name.trim().length > 0 &&
    name.trim().length <= 100 &&
    [...name.trim()].every(
      (char) => char.codePointAt(0)! > 31 && char.codePointAt(0) !== 127,
    );
  const group = detail.data;
  const members = new Set(group?.deviceIds ?? []);
  const filteredMembers = (group?.deviceIds ?? []).filter((id) =>
    id.includes(search),
  );
  const candidates = (devices.data ?? []).filter(
    (device) =>
      !members.has(device.deviceId) && device.deviceId.includes(search),
  );
  return (
    <section className="panel" aria-labelledby="groups-title">
      <Link className="text-link" to="/groups">
        グループ一覧
      </Link>
      <h2 id="groups-title" tabIndex={-1} ref={heading}>
        {groupId === undefined
          ? "機体グループ"
          : (group?.name ?? "グループ詳細")}
      </h2>
      <p>
        構成を5秒ごとに更新する。所属変更は既に受け付けた操作の対象を変更しない。
      </p>
      {active.isPending && (
        <p className="notice">グループを読み込んでいます…</p>
      )}
      {active.isError && (
        <p role="alert" className="notice notice-error">
          {active.error instanceof ApiError && active.error.status === 404
            ? "グループが見つかりません。削除された可能性があります。"
            : "グループを取得できませんでした。"}
        </p>
      )}
      {devices.isPending && <p>接続状態と機体一覧を読み込んでいます…</p>}
      {devices.isError && (
        <p role="alert">
          機体一覧を取得できませんでした。接続状態は未取得として表示します。
        </p>
      )}
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={() => void refresh()}
      >
        最新状態を再取得
      </button>
      {refreshError && (
        <p role="alert">再取得に失敗しました。APIの状態を確認してください。</p>
      )}
      <fieldset
        disabled={busy || (groupId !== undefined && !detail.isSuccess)}
        className="group-form"
      >
        <legend>{groupId === undefined ? "グループ作成" : "名称変更"}</legend>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (nameValid)
              select(
                groupId === undefined
                  ? { type: "create", name: name.trim() }
                  : { type: "rename", groupId, name: name.trim() },
              );
          }}
        >
          <label htmlFor="group-name">グループ名</label>
          <input
            id="group-name"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            aria-describedby="group-name-help"
            required
          />
          <p id="group-name-help">1〜100文字。前後の空白は除去する。</p>
          <button type="submit" disabled={!nameValid}>
            {groupId === undefined ? "作成内容を確認" : "名称変更を確認"}
          </button>
        </form>
      </fieldset>
      {groupId === undefined && groups.isSuccess && (
        <>
          {groups.data.length === 0 ? (
            <p className="empty-state">グループはありません。</p>
          ) : (
            <PagedList
              items={groups.data}
              label="グループ一覧"
              render={(item) => (
                <li key={item.groupId}>
                  <Link to={`/groups/${encodeURIComponent(item.groupId)}`}>
                    {item.name}
                  </Link>
                  <p>{counts(item, deviceMap)}</p>
                </li>
              )}
            />
          )}
        </>
      )}
      {groupId !== undefined && group && (
        <>
          <p aria-label="所属台数と接続状態">{counts(group, deviceMap)}</p>
          <fieldset disabled={busy || !detail.isSuccess} className="group-form">
            <legend>所属機体の編集</legend>
            <label htmlFor="group-device-search">機体IDを検索</label>
            <input
              id="group-device-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <h3>所属機体</h3>
            {group.deviceIds.length === 0 && <p>所属機体はありません。</p>}
            {group.deviceIds.length > 0 && filteredMembers.length === 0 && (
              <p>一致する所属機体はありません。</p>
            )}
            <PagedList
              key={`members:${search}`}
              items={filteredMembers}
              label="所属機体一覧"
              render={(id) => (
                <li key={id}>
                  <Link to={`/devices/${encodeURIComponent(id)}`}>{id}</Link>
                  <span>
                    {deviceMap?.get(id)?.connectionStatus ?? "状態未取得"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      select({ type: "remove", groupId, deviceId: id })
                    }
                  >
                    {id}の所属を解除
                  </button>
                </li>
              )}
            />
            <h3>追加できる機体</h3>
            {devices.isSuccess && candidates.length === 0 && (
              <p>追加できる機体はありません。</p>
            )}
            {devices.isSuccess && (
              <PagedList
                key={`candidates:${search}`}
                items={candidates}
                label="追加候補一覧"
                render={(item) => (
                  <li key={item.deviceId}>
                    <span>
                      {item.deviceId} / {item.connectionStatus}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        select({
                          type: "add",
                          groupId,
                          deviceId: item.deviceId,
                        })
                      }
                    >
                      {item.deviceId}を追加
                    </button>
                  </li>
                )}
              />
            )}
          </fieldset>
          <button
            type="button"
            disabled={busy || !detail.isSuccess}
            onClick={() =>
              select({ type: "delete", groupId, name: group.name })
            }
          >
            グループを削除
          </button>
        </>
      )}
      {confirmation && (
        <div
          className="command-confirmation"
          role="dialog"
          aria-labelledby="group-confirmation-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !mutation.isPending) {
              setConfirmation(null);
              mutation.reset();
              heading.current?.focus();
            }
          }}
        >
          <h3 id="group-confirmation-title">
            {actionText(confirmation)}しますか？
          </h3>
          {confirmation.type === "delete" && (
            <p>
              通常の一覧から非表示になり、以後の編集はできません。機体と過去の操作履歴は削除しません。
            </p>
          )}
          {confirmation.type === "remove" && (
            <p>グループから所属を外します。機体そのものは削除しません。</p>
          )}
          <div className="confirmation-actions">
            <button
              ref={cancel}
              type="button"
              disabled={mutation.isPending}
              onClick={() => {
                setConfirmation(null);
                mutation.reset();
                heading.current?.focus();
              }}
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={mutation.isPending || active.isError}
              onClick={() => {
                if (!sending.current && confirmation) {
                  sending.current = true;
                  mutation.mutate(confirmation);
                }
              }}
            >
              {mutation.isPending ? "送信中…" : "確定する"}
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="command-success">
          {message}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="command-error">
          操作に失敗しました。
          {mutation.error instanceof ApiError && mutation.error.status === 409
            ? "他の操作で既に所属が変更された可能性があります。最新状態を再取得して確認してください。"
            : mutation.error instanceof ApiError &&
                mutation.error.status === 404
              ? "対象が削除された可能性があります。最新状態を再取得してください。"
              : "通信エラーの場合は変更済みの可能性もあるため、再取得して確認してください。"}
        </p>
      )}
    </section>
  );
}
