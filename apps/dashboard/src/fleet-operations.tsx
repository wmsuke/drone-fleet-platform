import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "./api.js";
import {
  fetchOperation,
  fetchOperations,
  isOperationId,
  operationLabels,
  targetLabels,
  type OperationStatus,
  type TargetStatus,
  type Page,
} from "./fleet-operations-api.js";

const time = (v: string) => new Date(v).toLocaleString("ja-JP");
function Pagination({
  page,
  onChange,
}: {
  page: Page<unknown>;
  onChange: (offset: number) => void;
}) {
  return (
    <nav className="confirmation-actions" aria-label="操作結果のページ">
      <button
        type="button"
        disabled={page.offset === 0}
        onClick={() => onChange(Math.max(0, page.offset - page.limit))}
      >
        前のページ
      </button>
      <span>
        {page.total}件中 {page.items.length ? page.offset + 1 : 0}〜
        {page.items.length ? page.offset + page.items.length : 0}件
      </span>
      <button
        type="button"
        disabled={page.offset + page.limit >= page.total}
        onClick={() => onChange(page.offset + page.limit)}
      >
        次のページ
      </button>
    </nav>
  );
}
export function FleetOperationsPage({
  apiBaseUrl,
}: {
  apiBaseUrl: string | null;
}) {
  const { operationId } = useParams();
  if (!apiBaseUrl)
    return (
      <section className="panel">
        <h2>グループ操作</h2>
        <p role="alert">
          API接続先が設定されていません。VITE_API_BASE_URLを設定してください。
        </p>
      </section>
    );
  if (operationId && !isOperationId(operationId))
    return (
      <section className="panel">
        <h2>グループ操作</h2>
        <p role="alert">操作IDの形式が不正です。</p>
      </section>
    );
  return (
    <ConnectedOperations
      key={`${apiBaseUrl}:${operationId ?? "list"}`}
      base={apiBaseUrl}
      operationId={operationId?.toLowerCase()}
    />
  );
}
function ConnectedOperations({
  base,
  operationId,
}: {
  base: string;
  operationId?: string;
}) {
  const [params, setParams] = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [operationId]);
  const offsetText = params.get("offset") ?? "0";
  const offset = /^(0|[1-9]\d*)$/.test(offsetText) ? Number(offsetText) : NaN;
  const filter = params.get("status") ?? "";
  const groupId = params.get("groupId") ?? undefined;
  const valid =
    Number.isSafeInteger(offset) &&
    offset <= 1_000_000 &&
    (operationId
      ? !filter || Object.hasOwn(targetLabels, filter)
      : (!filter || Object.hasOwn(operationLabels, filter)) &&
        (!groupId || isOperationId(groupId)));
  const update = (next: { status?: string; offset?: number }) => {
    const copy = new URLSearchParams(params);
    if (next.status !== undefined) {
      if (next.status) copy.set("status", next.status);
      else copy.delete("status");
      copy.delete("offset");
    }
    if (next.offset !== undefined) copy.set("offset", String(next.offset));
    setParams(copy);
  };
  const list = useQuery({
    queryKey: ["fleet-operations", base, groupId, filter, offset],
    queryFn: ({ signal }) =>
      fetchOperations(
        base,
        {
          groupId,
          status: (filter || undefined) as OperationStatus | undefined,
          offset,
        },
        signal,
      ),
    enabled: !operationId && valid,
    retry: false,
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: ["fleet-operation", base, operationId, filter, offset],
    queryFn: ({ signal }) =>
      fetchOperation(
        base,
        operationId!,
        { status: (filter || undefined) as TargetStatus | undefined, offset },
        signal,
      ),
    enabled: !!operationId && valid,
    retry: false,
    refetchInterval: 5000,
  });
  const query = operationId ? detail : list;
  return (
    <section
      className="panel operation-panel"
      aria-labelledby="operation-title"
    >
      <Link className="text-link" to="/fleet-operations">
        グループ操作一覧
      </Link>
      <h2 ref={heading} tabIndex={-1} id="operation-title">
        {operationId ? "グループ操作の結果" : "グループ操作一覧"}
      </h2>
      <p>
        5秒ごとに更新する。受領は実行完了ではありません。未応答・結果不明は物理的な失敗の断定ではなく、後着結果で表示が変わる場合があります。
      </p>
      {!valid ? (
        <p role="alert">
          絞り込み条件が不正です。
          <Link
            to={
              operationId
                ? `/fleet-operations/${operationId}`
                : "/fleet-operations"
            }
          >
            条件を解除
          </Link>
        </p>
      ) : (
        <>
          <div className="operation-toolbar">
            <label htmlFor="operation-filter">
              {operationId ? "対象の状態で絞り込む" : "全体の状態で絞り込む"}
            </label>
            <select
              id="operation-filter"
              value={filter}
              onChange={(e) => update({ status: e.target.value })}
            >
              <option value="">すべて</option>
              {Object.entries(operationId ? targetLabels : operationLabels).map(
                ([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ),
              )}
            </select>
            <button
              type="button"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              結果を再取得
            </button>
          </div>
          {query.isPending && <p role="status">操作結果を読み込んでいます…</p>}
          {query.isFetching && !query.isPending && (
            <p role="status">操作結果を更新中…</p>
          )}
          {query.isError && (
            <p role="alert" className="notice notice-error">
              {query.error instanceof ApiError && query.error.status === 404
                ? "操作が見つかりません。操作IDを確認してください。"
                : "操作結果を取得できませんでした。表示が残っている場合は前回取得した結果です。再取得してください。"}
            </p>
          )}
          {!operationId && list.data && (
            <>
              {groupId && (
                <p>
                  対象グループID:{" "}
                  <span className="operation-id">{groupId}</span>
                </p>
              )}
              {!list.data.items.length && <p>該当する操作はありません。</p>}
              <ul
                className="command-history-list"
                aria-label="グループ操作の履歴"
              >
                {list.data.items.map((o) => (
                  <li className="command-history-item" key={o.operationId}>
                    <Link to={`/fleet-operations/${o.operationId}`}>
                      {o.groupName} / {o.type === "REBOOT" ? "再起動" : "帰還"}
                    </Link>
                    <p>
                      {operationLabels[o.status]} — 対象{o.targetCount}台 / 完了
                      {o.succeededCount}台 / 不成功{o.unsuccessfulCount}台 /
                      進行中{o.inProgressCount}台
                    </p>
                    <p>
                      受付 {time(o.createdAt)} / 操作ID{" "}
                      <span className="operation-id">{o.operationId}</span>
                    </p>
                  </li>
                ))}
              </ul>
              <Pagination
                page={list.data}
                onChange={(offset) => update({ offset })}
              />
            </>
          )}
          {operationId && detail.data && (
            <>
              <p>
                <Link to={`/groups/${detail.data.groupId}`}>
                  {detail.data.groupName}
                </Link>{" "}
                / {detail.data.type === "REBOOT" ? "再起動" : "帰還"} /
                受付時構成 revision {detail.data.groupRevision}
              </p>
              <p className="operation-id">操作ID: {detail.data.operationId}</p>
              <p role="status" aria-live="polite">
                全体: {operationLabels[detail.data.status]}。対象
                {detail.data.targetCount}台 / 完了{detail.data.succeededCount}台
                / 不成功{detail.data.unsuccessfulCount}台 / 進行中
                {detail.data.inProgressCount}台。受領記録
                {detail.data.acknowledgedCount}台（別指標）。
              </p>
              <dl className="operation-counts" aria-label="全対象の結果内訳">
                {Object.entries(targetLabels).map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{detail.data.counts[key as TargetStatus]}台</dd>
                  </div>
                ))}
              </dl>
              <p>
                受付 {time(detail.data.createdAt)} / 開始期限{" "}
                {time(detail.data.expiresAt)} / 結果確認期限{" "}
                {time(detail.data.resultDeadline)}
              </p>
              <p>
                評価時刻 {time(detail.data.evaluatedAt)} / 最終更新{" "}
                {time(detail.data.updatedAt)}
              </p>
              <h3 id="targets-title">受付時に確定した対象機体</h3>
              <p>
                現在のgroup構成とは独立した対象です。絞り込んでも上の全体件数は変わりません。
              </p>
              {!detail.data.targets.items.length && (
                <p>この条件・ページに一致する対象はありません。</p>
              )}
              <div
                className="operation-table"
                role="region"
                aria-labelledby="targets-title"
                tabIndex={0}
              >
                <table>
                  <caption>対象ごとのcommand状態と更新時刻</caption>
                  <thead>
                    <tr>
                      <th scope="col">機体 / command ID</th>
                      <th scope="col">状態</th>
                      <th scope="col">配送 / 実行の正本</th>
                      <th scope="col">最終更新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.targets.items.map((t) => (
                      <tr key={t.commandId}>
                        <th scope="row">
                          <Link
                            to={`/devices/${encodeURIComponent(t.deviceId)}`}
                          >
                            {t.deviceId}
                          </Link>
                          <span className="operation-id">{t.commandId}</span>
                        </th>
                        <td>
                          {targetLabels[t.status]}
                          <small>
                            受領:{" "}
                            {t.acknowledgementReceivedAt
                              ? time(t.acknowledgementReceivedAt)
                              : "未確認"}
                          </small>
                        </td>
                        <td>
                          {t.commandStatus} / {t.executionStatus}
                          <small>
                            outbox: {t.outboxState ?? "記録なし"} / 試行
                            {t.attempts}回・失敗{t.failures}回
                          </small>
                        </td>
                        <td>{time(t.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={detail.data.targets}
                onChange={(offset) => update({ offset })}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
