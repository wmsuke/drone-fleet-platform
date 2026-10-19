import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAlert, fetchAlerts, type AlertItem } from "./alerts-api.js";
const kinds = {
  OFFLINE: "通信断",
  LOW_BATTERY: "低バッテリー",
  COMMAND_OUTCOME: "command結果",
};
const time = (s: string) => new Date(s).toLocaleString("ja-JP");
function State({ item }: { item: AlertItem }) {
  return (
    <>
      <span>{item.status === "ACTIVE" ? "発生中" : "解除済み"}</span> /{" "}
      <span>{item.acknowledgedAt ? "確認済み" : "未確認"}</span>
    </>
  );
}
export function AlertsPage({ apiBaseUrl }: { apiBaseUrl: string | null }) {
  const { alertId } = useParams();
  if (!apiBaseUrl)
    return (
      <section className="panel">
        <h2>alert</h2>
        <p role="alert">API接続先が設定されていません。</p>
      </section>
    );
  return alertId ? (
    <Detail key={alertId} base={apiBaseUrl} id={alertId} />
  ) : (
    <List base={apiBaseUrl} />
  );
}
function List({ base }: { base: string }) {
  const [params, setParams] = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  const [formError, setFormError] = useState("");
  const query = new URLSearchParams(params);
  query.set("limit", "20");
  const offset = Number(params.get("offset") ?? 0);
  const result = useQuery({
    queryKey: ["alerts", base, query.toString()],
    queryFn: ({ signal }) => fetchAlerts(base, query.toString(), signal),
    refetchInterval: 5000,
    retry: false,
  });
  useEffect(() => {
    heading.current?.focus();
  }, [params]);
  return (
    <section className="panel alert-panel">
      <h2 tabIndex={-1} ref={heading}>
        alert一覧
      </h2>
      <p>5秒ごとに更新。解除状態と確認状態は独立している。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const next = new URLSearchParams();
          for (const [key, value] of data) {
            if (String(value)) {
              if (key === "from" || key === "to") {
                const d = new Date(String(value));
                if (!Number.isFinite(d.getTime())) {
                  setFormError("期間が不正です");
                  return;
                }
                next.set(key, d.toISOString());
              } else next.set(key, String(value));
            }
          }
          if (
            next.get("from") &&
            next.get("to") &&
            Date.parse(next.get("from")!) > Date.parse(next.get("to")!)
          ) {
            setFormError("開始時刻は終了時刻以前にしてください");
            return;
          }
          setFormError("");
          setParams(next);
        }}
        key={params.toString()}
        className="operation-toolbar alert-filters"
      >
        <label>
          状態
          <select name="status" defaultValue={params.get("status") ?? ""}>
            <option value="">すべて</option>
            <option value="ACTIVE">発生中</option>
            <option value="RESOLVED">解除済み</option>
          </select>
        </label>
        <label>
          確認状態
          <select
            name="acknowledged"
            defaultValue={params.get("acknowledged") ?? ""}
          >
            <option value="">すべて</option>
            <option value="false">未確認</option>
            <option value="true">確認済み</option>
          </select>
        </label>
        <label>
          severity
          <select name="severity" defaultValue={params.get("severity") ?? ""}>
            <option value="">すべて</option>
            <option value="warning">warning（警告）</option>
          </select>
        </label>
        <label>
          種類
          <select name="kind" defaultValue={params.get("kind") ?? ""}>
            <option value="">すべて</option>
            {Object.entries(kinds).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ["deviceId", "機体ID"],
            ["groupId", "グループID"],
            ["operationId", "操作ID"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input name={key} defaultValue={params.get(key) ?? ""} />
          </label>
        ))}
        {(
          [
            ["from", "発生開始（UTC）"],
            ["to", "発生終了（UTC）"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              name={key}
              placeholder="2026-10-19T00:00:00Z"
              defaultValue={params.get(key) ?? ""}
            />
          </label>
        ))}
        <button type="submit">絞り込む</button>
        <Link to="/alerts">条件をクリア</Link>
      </form>
      {formError && <p role="alert">{formError}</p>}
      {result.isPending && <p role="status">読み込み中…</p>}
      {result.isError && (
        <p role="alert">
          alertを取得できませんでした。
          {result.data
            ? "前回の取得結果を表示しています。"
            : "条件と接続を確認してください。"}
          <button onClick={() => void result.refetch()}>再試行</button>
        </p>
      )}
      {result.data && (
        <>
          <p role="status">
            全{result.data.total}件 /{" "}
            {result.data.items.length ? offset + 1 : 0}〜
            {offset + result.data.items.length}件
          </p>
          {!result.data.items.length ? (
            <p>該当するalertはありません。</p>
          ) : (
            <div
              role="region"
              aria-label="alert一覧テーブル"
              tabIndex={0}
              className="operation-table"
            >
              <table>
                <caption>alertの発生・確認状態</caption>
                <thead>
                  <tr>
                    {[
                      "種類",
                      "severity",
                      "機体",
                      "発生時刻",
                      "状態",
                      "詳細",
                    ].map((v) => (
                      <th key={v} scope="col">
                        {v}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((item) => (
                    <tr key={item.alertId}>
                      <td>{kinds[item.kind]}</td>
                      <td>warning（警告）</td>
                      <td>
                        <Link
                          to={`/devices/${encodeURIComponent(item.deviceId)}`}
                        >
                          {item.deviceId}
                        </Link>
                      </td>
                      <td>{time(item.occurredAt)}</td>
                      <td>
                        <State item={item} />
                      </td>
                      <td>
                        <Link
                          aria-label={`${item.deviceId} ${kinds[item.kind]}の詳細`}
                          to={`/alerts/${item.alertId}`}
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
          <nav aria-label="alertのページ送り">
            <button
              disabled={offset === 0}
              onClick={() =>
                setParams((p) => {
                  p.set("offset", String(Math.max(0, offset - 20)));
                  return p;
                })
              }
            >
              前へ
            </button>
            <button
              disabled={offset + 20 >= result.data.total}
              onClick={() =>
                setParams((p) => {
                  p.set("offset", String(offset + 20));
                  return p;
                })
              }
            >
              次へ
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
function Detail({ base, id }: { base: string; id: string }) {
  const client = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const result = useQuery({
    queryKey: ["alert", base, id],
    queryFn: ({ signal }) => fetchAlert(base, id, signal),
    refetchInterval: 5000,
    retry: false,
  });
  const ack = useMutation({
    onMutate: () => client.cancelQueries({ queryKey: ["alert", base, id] }),
    mutationFn: () => fetchAlert(base, id, undefined, true),
    onSuccess: async (item) => {
      await client.cancelQueries({ queryKey: ["alert", base, id] });
      client.setQueryData(["alert", base, id], item);
      void client.invalidateQueries({ queryKey: ["alerts"] });
      heading.current?.focus();
    },
    onError: () => button.current?.focus(),
  });
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const item = result.data;
  return (
    <section className="panel alert-panel">
      <Link to="/alerts">alert一覧へ</Link>
      <h2 ref={heading} tabIndex={-1}>
        alert詳細
      </h2>
      {result.isPending && <p role="status">読み込み中…</p>}
      {result.isError && (
        <p role="alert">
          alertを取得できませんでした。
          {item && "前回の取得結果を表示しています。"}
          <button onClick={() => void result.refetch()}>再試行</button>
        </p>
      )}
      {item && (
        <>
          <h3>{kinds[item.kind]} — warning（警告）</h3>
          <p>
            <State item={item} />
          </p>
          <dl>
            {[
              ["理由", item.reason],
              ["発生時刻", time(item.occurredAt)],
              ["最終観測", time(item.lastObservedAt)],
              ["解除時刻", item.resolvedAt ? time(item.resolvedAt) : "未解除"],
              [
                "確認時刻",
                item.acknowledgedAt ? time(item.acknowledgedAt) : "未確認",
              ],
              ["確認者", item.acknowledgedAt ? "匿名（本人性未確認）" : "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <p>
            認証未実装のため、確認者の本人性は保証できない。確認操作ではalertは解除されない。
          </p>
          <button
            ref={button}
            className="command-button"
            disabled={!!item.acknowledgedAt || ack.isPending}
            onClick={() => ack.mutate()}
          >
            {ack.isPending
              ? "保存中…"
              : item.acknowledgedAt
                ? "確認済み"
                : "確認済みにする"}
          </button>
          {ack.isError && (
            <p role="alert">
              確認状態を保存できませんでした。再試行してください。
            </p>
          )}
          {ack.isSuccess && <p role="status">確認状態を保存しました。</p>}
          <h3>関連情報</h3>
          <p>
            <Link to={`/audit-logs?alertId=${item.alertId}`}>
              このalertの監査ログ
            </Link>
          </p>
          <p>
            <Link to={`/devices/${encodeURIComponent(item.deviceId)}`}>
              機体 {item.deviceId}
            </Link>
          </p>
          {item.relatedGroups.map((g) => (
            <p key={g.groupId}>
              <Link to={`/groups/${g.groupId}`}>グループ {g.name}</Link>
            </p>
          ))}
          {item.operationId && (
            <p>
              <Link to={`/fleet-operations/${item.operationId}`}>
                グループ操作 {item.operationId}
              </Link>
            </p>
          )}
          {item.commandId && <p>commandId: {item.commandId}</p>}
        </>
      )}
    </section>
  );
}
