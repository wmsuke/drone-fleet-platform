import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "./api.js";
import {
  auditActions,
  fetchAudit,
  fetchAuditPage,
  metadataLabels,
  type AuditItem,
} from "./audit-api.js";
const results = {
  SUCCEEDED: "保存成功",
  REJECTED: "拒否",
  FAILED: "HTTP処理失敗",
};
function Actor({ item }: { item: AuditItem }) {
  return (
    <>
      {item.actorKind === "anonymous"
        ? "操作者未認証"
        : `system: ${item.actorId}`}
    </>
  );
}
function Related({ item }: { item: AuditItem }) {
  const groupId =
      item.groupId ?? (item.targetKind === "group" ? item.targetId : null),
    operationId =
      item.operationId ??
      (item.targetKind === "operation" ? item.targetId : null),
    alertId =
      item.alertId ?? (item.targetKind === "alert" ? item.targetId : null),
    commandId =
      item.commandId ?? (item.targetKind === "command" ? item.targetId : null);
  return (
    <nav aria-label="関連する操作と対象">
      <ul>
        {groupId && (
          <li>
            <Link to={`/groups/${groupId}`}>グループ {groupId}</Link>
          </li>
        )}
        {operationId && (
          <li>
            <Link to={`/fleet-operations/${operationId}`}>
              操作 {operationId}
            </Link>
          </li>
        )}
        {alertId && (
          <li>
            <Link to={`/alerts/${alertId}`}>alert {alertId}</Link>
          </li>
        )}
        {commandId && (
          <li>
            <Link to={`/audit-logs?commandId=${commandId}`}>
              commandの監査履歴 {commandId}
            </Link>
          </li>
        )}
        {item.deviceId && (
          <li>
            <Link
              to={`/devices/${encodeURIComponent(item.deviceId)}#command-history-title`}
            >
              機体・command履歴 {item.deviceId}
            </Link>
          </li>
        )}
        {item.requestId && (
          <li>
            <Link to={`/audit-logs?requestId=${item.requestId}`}>
              同じrequestIdの記録
            </Link>
          </li>
        )}
      </ul>
    </nav>
  );
}
export function AuditPage({ apiBaseUrl }: { apiBaseUrl: string | null }) {
  const { eventId } = useParams();
  if (!apiBaseUrl)
    return (
      <section className="panel">
        <h2>監査ログ</h2>
        <p role="alert">API接続先が設定されていません。</p>
      </section>
    );
  return eventId ? (
    <Detail key={eventId} base={apiBaseUrl} id={eventId} />
  ) : (
    <List base={apiBaseUrl} />
  );
}
function List({ base }: { base: string }) {
  const [params, setParams] = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState("");
  const query = new URLSearchParams(params);
  query.set("limit", "20");
  const data = useQuery({
    queryKey: ["audit-logs", base, query.toString()],
    queryFn: ({ signal }) => fetchAuditPage(base, query.toString(), signal),
    retry: false,
  });
  useEffect(() => {
    heading.current?.focus();
  }, [params]);
  return (
    <section className="panel alert-panel">
      <h2 ref={heading} tabIndex={-1}>
        監査ログ
      </h2>
      <p>
        閲覧専用。保存成功は機体の実行成功ではない。操作者未認証の記録は本人を特定できない。
      </p>
      <form
        className="operation-toolbar alert-filters"
        key={params.toString()}
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams();
          for (const [key, value] of new FormData(e.currentTarget)) {
            if (String(value)) next.set(key, String(value));
          }
          if (
            next.get("from") &&
            next.get("to") &&
            Date.parse(next.get("from")!) > Date.parse(next.get("to")!)
          ) {
            setError("開始時刻は終了時刻以前にしてください");
            return;
          }
          setError("");
          setParams(next);
        }}
      >
        {(
          [
            {
              name: "actorKind",
              label: "actor種別",
              values: ["anonymous", "system"],
            },
            {
              name: "actorId",
              label: "actor ID",
              values: [
                "telemetry-ingestor",
                "alert-evaluator",
                "operation-evaluator",
                "ota-worker",
              ],
            },
            { name: "action", label: "action", values: auditActions },
            {
              name: "targetKind",
              label: "対象種別",
              values: [
                "group",
                "device",
                "command",
                "operation",
                "alert",
                "release",
                "deployment",
              ],
            },
            {
              name: "result",
              label: "結果",
              values: ["SUCCEEDED", "REJECTED", "FAILED"],
            },
          ] as const
        ).map((field) => (
          <label key={field.name}>
            {field.label}
            <select
              name={field.name}
              defaultValue={params.get(field.name) ?? ""}
            >
              <option value="">すべて</option>
              {field.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ))}
        {(
          [
            ["from", "記録開始（UTC）"],
            ["to", "記録終了（UTC）"],
            ["targetId", "対象ID"],
            ["requestId", "requestId"],
            ["groupId", "groupId"],
            ["operationId", "operationId"],
            ["commandId", "commandId"],
            ["alertId", "alertId"],
          ] as const
        ).map(([name, label]) => (
          <label key={name}>
            {label}
            <input
              name={name}
              defaultValue={params.get(name) ?? ""}
              placeholder={
                name === "from" || name === "to"
                  ? "2026-10-19T00:00:00Z"
                  : undefined
              }
            />
          </label>
        ))}
        <button type="submit">検索する</button>
        <Link to="/audit-logs">条件をクリア</Link>
      </form>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => void data.refetch()} disabled={data.isFetching}>
        このページを再取得
      </button>
      {data.isPending && <p role="status">読み込み中…</p>}
      {data.isError && (
        <p role="alert">
          監査ログを取得できませんでした。
          {data.data
            ? "前回の結果を表示しています。"
            : "検索条件とAPI接続を確認してください。"}
        </p>
      )}
      {data.data && (
        <>
          <p role="status">
            このページに{data.data.items.length}件
            {data.data.nextCursor ? "（続きあり）" : ""}
          </p>
          {data.data.items.length === 0 ? (
            <p>該当する監査ログはありません。</p>
          ) : (
            <div
              className="operation-table"
              role="region"
              aria-label="監査ログの表"
              tabIndex={0}
            >
              <table>
                <caption>記録時刻降順・同時刻はeventId降順</caption>
                <thead>
                  <tr>
                    {[
                      "記録時刻（UTC）",
                      "actor",
                      "action",
                      "対象",
                      "結果",
                      "詳細",
                    ].map((v) => (
                      <th scope="col" key={v}>
                        {v}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.data.items.map((item) => (
                    <tr key={item.eventId}>
                      <td>
                        <time dateTime={item.occurredAt}>
                          {item.occurredAt}
                        </time>
                      </td>
                      <td>
                        <Actor item={item} />
                      </td>
                      <td>{item.action}</td>
                      <td>
                        {item.targetKind}
                        <br />
                        {item.targetId ?? "対象ID未確定"}
                      </td>
                      <td>{results[item.result]}</td>
                      <td>
                        <Link
                          to={`/audit-logs/${item.eventId}?${params}`}
                          aria-label={`記録 ${item.eventId} の詳細`}
                        >
                          詳細
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label="監査ログのページ送り">
            {params.has("cursor") && (
              <button
                onClick={() =>
                  setParams((p) => {
                    p.delete("cursor");
                    return p;
                  })
                }
              >
                検索の先頭へ
              </button>
            )}
            <button
              disabled={!data.data.nextCursor}
              onClick={() =>
                setParams((p) => {
                  p.set("cursor", data.data!.nextCursor!);
                  return p;
                })
              }
            >
              次の20件
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
function Detail({ base, id }: { base: string; id: string }) {
  const [params] = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  const data = useQuery({
    queryKey: ["audit-log", base, id],
    queryFn: ({ signal }) => fetchAudit(base, id, signal),
    retry: false,
  });
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const item = data.data;
  return (
    <section className="panel alert-panel">
      <Link to={`/audit-logs?${params}`}>検索結果へ戻る</Link>
      <h2 ref={heading} tabIndex={-1}>
        監査ログ詳細
      </h2>
      {data.isPending && <p role="status">読み込み中…</p>}
      {data.isError && (
        <p role="alert">
          {data.error instanceof ApiError && data.error.status === 404
            ? "記録が見つかりません。"
            : "監査ログを取得できませんでした。"}
          <button onClick={() => void data.refetch()}>再試行</button>
        </p>
      )}
      {item && (
        <>
          <p>
            閲覧専用。操作者未認証の記録は本人確認の証拠にならない。保存成功は機体の実行完了ではない。
          </p>
          <dl>
            {[
              ["eventId", item.eventId],
              ["schema version", item.schemaVersion],
              ["記録時刻（UTC）", item.occurredAt],
              ["actor種別", item.actorKind],
              ["actor ID", item.actorId ?? "未認証・識別なし"],
              ["action", item.action],
              ["対象種別", item.targetKind],
              ["対象ID", item.targetId ?? "未確定"],
              ["結果", results[item.result]],
              ["requestId", item.requestId ?? "なし"],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <h3>公開metadata</h3>
          {Object.keys(item.metadata).length ? (
            <dl>
              {Object.entries(metadataLabels).flatMap(([key, label]) => {
                const value = item.metadata[key as keyof typeof metadataLabels];
                return value === undefined
                  ? []
                  : [
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>
                          {value === null
                            ? "なし"
                            : typeof value === "boolean"
                              ? value
                                ? "変更あり"
                                : "変更なし"
                              : String(value)}
                        </dd>
                      </div>,
                    ];
              })}
            </dl>
          ) : (
            <p>公開する追加情報はありません。</p>
          )}
          <h3>関連情報</h3>
          <Related item={item} />
        </>
      )}
    </section>
  );
}
