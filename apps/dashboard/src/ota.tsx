import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  fetchDeployment,
  fetchDeployments,
  uuid,
  type Intent,
} from "./ota-api.js";
import { OtaCreate } from "./ota-create.js";
import { OtaDetail } from "./ota-detail.js";
import { actionBlock } from "./ota-safety.js";
import { OtaConfirmation, useOtaRequest } from "./ota-request.js";

export const otaLabels: Record<string, string> = {
  ACCEPTED: "受付済み・承認待ち",
  RUNNING: "実行中",
  STOPPING: "停止要求中・確認待ち",
  PAUSED: "配信停止確認済み",
  WAITING_FOR_HUMAN: "人間判断待ち",
  COMPLETED: "全対象の更新成功",
  FAILED: "失敗",
  CANCELLED: "取消",
  SUCCEEDED: "成功評価",
  UNCERTAIN: "結果不明",
  RECOVERED: "旧版への回復成功・元更新は不成功",
  RECOVERING: "復旧中",
  QUEUED: "待機",
  UPDATING: "更新中",
  STOPPED: "更新手順停止・物理停止ではない",
  APPLIED: "適用済み・成功評価は別",
  DOWNLOADING: "取得中",
  VERIFIED: "検証済み・適用前",
  QUIESCING: "切替準備中",
  SWITCHING: "版の切替中",
  BOOTING: "起動中",
  HEALTH_CHECKING: "継続health確認中",
  EXPIRED: "開始期限切れ",
  PENDING: "待機",
  HELD: "未解禁",
  ACKNOWLEDGED: "受領済み・完了ではない",
  AWAITING_APPROVAL: "承認待ち",
  PASSED: "全対象成功確認済み",
  WAITING: "復旧承認済み・開始待ち",
  UNAVAILABLE: "復旧不能・要求拒否",
};
export const otaLabel = (value: string | null) =>
  value === null ? "未報告" : `${otaLabels[value] ?? value} (${value})`;
export const otaTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未取得";
export function OtaPage({ apiBaseUrl }: { apiBaseUrl: string | null }) {
  const { deploymentId } = useParams();
  if (!apiBaseUrl)
    return (
      <section className="panel">
        <h2>OTA配信</h2>
        <p role="alert">API接続先が設定されていません。</p>
      </section>
    );
  if (deploymentId && !uuid.safeParse(deploymentId).success)
    return (
      <section className="panel">
        <h2>OTA配信</h2>
        <p role="alert">配信IDの形式が不正です。</p>
      </section>
    );
  return (
    <ConnectedOta
      key={`${apiBaseUrl}:${deploymentId ?? "list"}`}
      base={apiBaseUrl}
      id={deploymentId?.toLowerCase()}
    />
  );
}
function ConnectedOta({ base, id }: { base: string; id?: string }) {
  const client = useQueryClient(),
    navigate = useNavigate(),
    heading = useRef<HTMLHeadingElement>(null);
  const [params, setParams] = useSearchParams(),
    [preview, setPreview] = useState<{
      intent: Intent;
      summary: ReactNode;
      attemptId?: string;
    } | null>(null),
    [, tick] = useState(0);
  const before = params.get("before") ?? undefined,
    beforeId = params.get("beforeId") ?? undefined;
  const valid =
    (!before ||
      (/^\d{4}-\d{2}-\d{2}T/.test(before) &&
        Number.isFinite(Date.parse(before)))) &&
    (!beforeId || (!!before && uuid.safeParse(beforeId).success));
  const list = useQuery({
    queryKey: ["ota-list", base, before, beforeId],
    queryFn: ({ signal }) => fetchDeployments(base, before, beforeId, signal),
    enabled: !id && valid,
    retry: false,
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: ["ota-detail", base, id],
    queryFn: ({ signal }) => fetchDeployment(base, id!, signal),
    enabled: !!id,
    retry: false,
    refetchInterval: 5000,
  });
  const action = useOtaRequest(base, (acceptedId) => {
    void client.invalidateQueries({ queryKey: ["ota-detail", base] });
    void client.invalidateQueries({ queryKey: ["ota-interventions", base] });
    void client.invalidateQueries({ queryKey: ["ota-list", base] });
    if (!id || acceptedId !== id) navigate(`/deployments/${acceptedId}`);
  });
  useEffect(() => {
    heading.current?.focus();
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [id]);
  const q = id ? detail : list;
  const now = detail.data
    ? Date.parse(detail.data.evaluatedAt) +
      Math.max(0, Date.now() - detail.dataUpdatedAt)
    : Date.now();
  const unavailable =
    action.blocked ||
    (!!id &&
      (detail.isError ||
        detail.isFetching ||
        !detail.data ||
        Date.now() - detail.dataUpdatedAt >= 10000));
  const previewTargetId =
    preview && "targetId" in preview.intent
      ? preview.intent.targetId
      : undefined;
  const block = preview
    ? unavailable
      ? "受付確認待ち、または最新の配信情報を確認できません"
      : (actionBlock(preview.intent, detail.data, now) ??
        (preview.attemptId &&
        "targetId" in preview.intent &&
        detail.data?.targets.find((t) => t.targetId === previewTargetId)
          ?.attempts[0]?.attemptId !== preview.attemptId
          ? "確認中に試行が変わりました。最新状態から確認し直してください"
          : null))
    : null;
  const open = (intent: Intent, summary: ReactNode) => {
    if (!unavailable)
      setPreview({
        intent,
        summary,
        attemptId:
          "targetId" in intent
            ? detail.data?.targets.find((t) => t.targetId === intent.targetId)
                ?.attempts[0]?.attemptId
            : undefined,
      });
  };
  return (
    <section className="panel ota-panel" aria-labelledby="ota-title">
      <Link to="/deployments">配信一覧</Link>
      <h2 id="ota-title" tabIndex={-1} ref={heading}>
        {id ? "OTA配信の詳細" : "OTA配信"}
      </h2>
      <p>
        5秒ごとに更新する。停止要求・停止確認、更新成功・旧版回復、人間判断の終了は別の事実です。管理APIは本人認証なしのローカル・制限ネットワーク専用です。
      </p>
      {action.panel}
      <button
        type="button"
        disabled={q.isFetching || !valid}
        onClick={() => void q.refetch()}
      >
        最新状態を取得
      </button>
      {!valid && (
        <p role="alert">
          ページ条件が不正です。<Link to="/deployments">一覧へ戻る</Link>
        </p>
      )}
      {q.isPending && <p role="status">配信情報を読み込み中…</p>}
      {q.isError && (
        <p role="alert">
          配信情報を取得できません。古い表示からは操作できません。
          <button type="button" onClick={() => void q.refetch()}>
            配信情報を再取得
          </button>
        </p>
      )}
      {preview && (
        <OtaConfirmation
          key={JSON.stringify(preview.intent)}
          intent={preview.intent}
          summary={preview.summary}
          blocked={block}
          onCancel={() => setPreview(null)}
          onSubmit={() => {
            if (!block) {
              action.send(preview.intent);
              setPreview(null);
            }
          }}
        />
      )}
      {id && detail.data ? (
        <OtaDetail
          base={base}
          data={detail.data}
          now={now}
          disabled={unavailable || !!preview}
          preview={open}
        />
      ) : (
        !id && (
          <>
            <OtaCreate
              base={base}
              disabled={action.blocked || !!preview}
              preview={open}
            />
            <h3>配信履歴</h3>
            {list.data?.items.length === 0 && <p>配信はありません。</p>}
            <ul className="group-items">
              {list.data?.items.map((d) => (
                <li key={d.deploymentId}>
                  <Link to={`/deployments/${d.deploymentId}`}>
                    {d.deploymentId}
                  </Link>{" "}
                  {otaLabel(d.status)} / 全{d.targetCount}台 /{" "}
                  {otaTime(d.createdAt)}
                </li>
              ))}
            </ul>
            <nav aria-label="配信履歴のページ">
              <button
                type="button"
                disabled={!before || list.isFetching}
                onClick={() => setParams({})}
              >
                最新の配信
              </button>
              <button
                type="button"
                disabled={!list.data?.nextBefore || list.isFetching}
                onClick={() =>
                  setParams({
                    before: list.data!.nextBefore!,
                    beforeId: list.data!.nextBeforeId!,
                  })
                }
              >
                以前の配信
              </button>
            </nav>
          </>
        )
      )}
    </section>
  );
}
