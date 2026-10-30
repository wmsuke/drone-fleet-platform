import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  fetchInterventions,
  reasonCode,
  actionLabels,
  type Deployment,
  type Target,
  type Intent,
  type Intervention,
} from "./ota-api.js";
import { actionBlock } from "./ota-safety.js";
import { otaLabel, otaTime } from "./ota.js";

type Preview = (intent: Intent, summary: React.ReactNode) => void;
function Control({
  intent,
  data,
  now,
  disabled,
  preview,
  summary,
}: {
  intent: Intent;
  data: Deployment;
  now: number;
  disabled: boolean;
  preview: Preview;
  summary?: React.ReactNode;
}) {
  const id = useId();
  const block = actionBlock(intent, data, now),
    reason =
      "reason" in intent.body &&
      !reasonCode.safeParse(intent.body.reason).success
        ? "理由コードを入力してください"
        : null;
  return (
    <span className="ota-control">
      <button
        type="button"
        disabled={disabled || !!block || !!reason}
        aria-describedby={id}
        onClick={() =>
          preview(
            intent,
            <>
              <p>配信: {data.deploymentId}</p>
              {summary}
              <p>現在状態: {otaLabel(data.status)}</p>
            </>,
          )
        }
      >
        {actionLabels[intent.action]}を確認
      </button>
      <small id={id}>
        {block ?? reason ?? "送信前に対象と影響を確認します"}
      </small>
    </span>
  );
}
export function OtaDetail({
  base,
  data,
  now,
  disabled,
  preview,
}: {
  base: string;
  data: Deployment;
  now: number;
  disabled: boolean;
  preview: Preview;
}) {
  const [reason, setReason] = useState(""),
    [params, setParams] = useSearchParams();
  const targetHeading = useRef<HTMLHeadingElement>(null);
  const text = params.get("targetPage") ?? "1",
    page = /^[1-9]\d*$/.test(text) ? Number(text) : NaN;
  const stageId = params.get("stage") ?? "",
    stageValid = !stageId || data.stages.some((s) => s.stageId === stageId),
    targets = data.targets.filter((t) => !stageId || t.stageId === stageId);
  const valid =
    Number.isSafeInteger(page) &&
    page >= 1 &&
    page <= Math.max(1, Math.ceil(targets.length / 20));
  const change = (next: number, stage = stageId) => {
    const copy = new URLSearchParams(params);
    copy.set("targetPage", String(next));
    if (stage) copy.set("stage", stage);
    else copy.delete("stage");
    setParams(copy);
  };
  const props = { data, now, disabled, preview };
  useEffect(() => {
    targetHeading.current?.focus();
  }, [page, stageId]);
  return (
    <>
      <dl className="ota-summary">
        <dt>配信ID</dt>
        <dd>{data.deploymentId}</dd>
        <dt>配信状態</dt>
        <dd>{otaLabel(data.status)}</dd>
        <dt>要求したrelease</dt>
        <dd>
          {data.releaseSnapshot.manifest.version} /{" "}
          {data.releaseSnapshot.manifest.releaseId}
          <br />
          {data.releaseSnapshot.manifest.digest}
        </dd>
        <dt>全段階の固定分母</dt>
        <dd>{data.targetCount}台</dd>
        <dt>最終照会</dt>
        <dd>{otaTime(data.evaluatedAt)}</dd>
        <dt>停止latch</dt>
        <dd>
          {data.control?.stoppedAt
            ? `${data.control.stopReason} / ${otaTime(data.control.stoppedAt)}`
            : "なし"}
        </dd>
      </dl>
      <p>
        <Link
          to={`/audit-logs?targetKind=deployment&targetId=${data.deploymentId}`}
        >
          この配信の監査ログ
        </Link>
      </p>
      <details>
        <summary>受付時の配信物と固定方針</summary>
        <pre>
          {JSON.stringify(
            { release: data.releaseSnapshot.manifest, policy: data.policy },
            null,
            2,
          )}
        </pre>
      </details>
      <section aria-labelledby="ota-control-title">
        <h3 id="ota-control-title">配信操作</h3>
        <label>
          操作理由コード
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={64}
            pattern="[A-Z][A-Z0-9_]{0,63}"
            aria-describedby="ota-reason-help"
            disabled={disabled}
          />
        </label>
        <p id="ota-reason-help">
          英大文字から始まる英大文字・数字・_、最大64文字。秘密値や自由文は入力しない。
        </p>
        <div className="confirmation-actions">
          <Control
            {...props}
            intent={{
              action: "STOP",
              deploymentId: data.deploymentId,
              body: { reason },
            }}
            summary={
              <p>
                後続配信を抑止し、送信済み要求は停止確認を待つ。適用済み版は戻さない。
              </p>
            }
          />
          <Control
            {...props}
            intent={{
              action: "RESUME",
              deploymentId: data.deploymentId,
              body: { reason },
            }}
            summary={
              <p>
                残る元の要求を再検証して再開する。失敗・結果不明の同じ試行を再適用せず、期限を延長しない。
              </p>
            }
          />
          <Control
            {...props}
            intent={{
              action: "START_REVIEW",
              deploymentId: data.deploymentId,
              body: { reason },
            }}
            summary={<p>判断対応を開始する。予約や停止latchは解除しない。</p>}
          />
        </div>
      </section>
      <h3>段階別の進捗</h3>
      <ol className="ota-stages">
        {data.stages.map((s) => (
          <li key={s.stageId}>
            <h4>
              段階{s.position + 1} — {otaLabel(s.status)}
            </h4>
            <p>
              固定{s.denominator}台 / 更新成功 {s.counts.SUCCEEDED ?? 0}台 /
              旧版回復 {s.counts.RECOVERED ?? 0}台 / 状態別件数{" "}
              {JSON.stringify(s.counts)}
            </p>
            <Control
              {...props}
              intent={{
                action: "APPROVE",
                deploymentId: data.deploymentId,
                stageId: s.stageId,
                body: { reason },
              }}
              summary={
                <>
                  <p>
                    段階{s.position + 1}: {s.deviceIds.length}台 —{" "}
                    {s.deviceIds.join(", ")}
                  </p>
                  <p>
                    全対象の開始300秒・結果600秒をこの承認で確定する。段階の同時開始・全件成功を保証しない。
                  </p>
                </>
              }
            />
          </li>
        ))}
      </ol>
      <h3 ref={targetHeading} tabIndex={-1}>
        対象機体と試行履歴
      </h3>
      <label>
        表示する段階
        <select value={stageId} onChange={(e) => change(1, e.target.value)}>
          <option value="">すべて</option>
          {data.stages.map((s) => (
            <option key={s.stageId} value={s.stageId}>
              段階{s.position + 1}
            </option>
          ))}
        </select>
      </label>
      {!valid || !stageValid ? (
        <p role="alert">
          対象ページ・段階が不正です。
          <button type="button" onClick={() => change(1, "")}>
            最初の対象ページへ
          </button>
        </p>
      ) : (
        <>
          <div
            className="table-scroll"
            role="region"
            aria-label="機体ごとの進捗"
            tabIndex={0}
          >
            <table>
              <caption>
                全{data.targetCount}台のうち表示対象{targets.length}
                台。1ページ20台。更新成功と旧版回復を区別する。
              </caption>
              <thead>
                <tr>
                  <th scope="col">機体</th>
                  <th scope="col">現在版・boot</th>
                  <th scope="col">配送 / 適用 / 評価</th>
                  <th scope="col">根拠・履歴・復旧</th>
                </tr>
              </thead>
              <tbody>
                {targets.slice((page - 1) * 20, page * 20).map((t) => (
                  <TargetRow
                    key={t.targetId}
                    target={t}
                    {...props}
                    reason={reason}
                    base={base}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="OTA対象のページ">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => change(page - 1)}
            >
              前の対象ページ
            </button>
            <span>
              {page} / {Math.max(1, Math.ceil(targets.length / 20))}
            </span>
            <button
              type="button"
              disabled={page * 20 >= targets.length}
              onClick={() => change(page + 1)}
            >
              次の対象ページ
            </button>
          </nav>
        </>
      )}
      <h3>復旧要求と回復評価</h3>
      {data.recoveries.length === 0 && <p>復旧要求はありません。</p>}
      <ul className="ota-records">
        {data.recoveries.map((r) => (
          <li key={r.recoveryId} id={`recovery-${r.recoveryId}`}>
            <p>
              {r.kind} —{" "}
              {r.kind === "ROLLBACK" && r.status === "SUCCEEDED"
                ? "旧版への回復成功（元更新の成功ではない）"
                : otaLabel(r.status)}
            </p>
            <p>
              recoveryId: {r.recoveryId} / 元attempt: {r.previousAttemptId} /
              新attempt: {r.attemptId ?? "未作成"}
            </p>
            <p>
              理由: {r.reason} / 失敗理由: {r.failureReason ?? "なし"} /
              必要対応: {r.requiredAction ?? "なし"}
            </p>
            <p>
              検出 {otaTime(r.detectedAt)} / 承認 {otaTime(r.approvedAt)} / 開始{" "}
              {otaTime(r.startedAt)} / 終了 {otaTime(r.finishedAt)} / 総期限{" "}
              {otaTime(r.budgetDeadline)}
            </p>
            <p>
              転送bytes（累計）: {r.downloadedBytes ?? "未取得"} / 承認時:{" "}
              {r.bytesAtApproval ?? "未取得"} / 費用:{" "}
              {r.cost ? `${r.cost.amount} ${r.cost.currency}` : "未取得"}
            </p>
            <details>
              <summary>復旧評価の証拠event ID</summary>
              <pre>{JSON.stringify(r.evidence, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
      <h3>人間介入</h3>
      <p>
        必須承認 {data.interventionSummary.requiredApprovalCount}件 / 障害対応{" "}
        {data.interventionSummary.faultResponseCount}件 / 未終了{" "}
        {data.interventionSummary.openReviewCount}件 / 旧操作の詳細欠落{" "}
        {data.interventionSummary.legacyOperationCount}件。
      </p>
      <p>
        {data.interventionSummary.excludesAutonomousCompletion
          ? "人間介入あり。自律完了から除外する根拠が残っています。"
          : "介入記録なしは、自律完了の証明ではありません。"}{" "}
        未取得の時間・費用は0ではありません。
      </p>
      <Interventions base={base} {...props} />
    </>
  );
}
function TargetRow({
  target: t,
  data,
  now,
  disabled,
  preview,
  reason,
  base,
}: {
  target: Target;
  data: Deployment;
  now: number;
  disabled: boolean;
  preview: Preview;
  reason: string;
  base: string;
}) {
  const [expanded, setExpanded] = useState(false),
    a = t.attempts[0]!;
  return (
    <tr>
      <th scope="row">
        <Link to={`/devices/${encodeURIComponent(t.deviceId)}`}>
          {t.deviceId}
        </Link>
        <p>{otaLabel(t.status)}</p>
      </th>
      <td>
        {t.current ? (
          <>
            {t.current.version}
            <br />
            <code>{t.current.digest}</code>
            <br />
            boot: {t.current.bootId}
            <br />
            観測 {otaTime(t.current.observedAt)}
          </>
        ) : (
          "現在版未確認"
        )}
      </td>
      <td>
        配送: {otaLabel(a.deliveryStatus)}
        <br />
        適用: {otaLabel(a.applicationStatus)}
        <br />
        評価: {otaLabel(a.evaluationStatus)}
        <br />
        {a.purpose === "ROLLBACK" && "旧版回復の評価。元更新の成功ではない。"}
        <p>
          停止:{" "}
          {a.stop
            ? a.stop.confirmedEventId
              ? "停止通知確認済み（配信全体の終端は別判定）"
              : "停止要求済み・未確認"
            : "STOP要求なし"}
        </p>
      </td>
      <td>
        <details onToggle={(e) => setExpanded(e.currentTarget.open)}>
          <summary>{t.deviceId}の根拠・履歴・復旧</summary>
          {expanded && (
            <>
              <div className="confirmation-actions">
                {(["RETRY", "ROLLBACK"] as const).map((kind) => (
                  <Control
                    key={kind}
                    intent={{
                      action: kind,
                      deploymentId: data.deploymentId,
                      targetId: t.targetId,
                      body: { reason },
                    }}
                    data={data}
                    now={now}
                    disabled={disabled}
                    preview={preview}
                    summary={
                      <>
                        <p>
                          対象: {t.deviceId} / 前attempt: {a.attemptId}
                        </p>
                        <p>
                          {kind === "RETRY"
                            ? "適用前の一時download失敗を新しい試行でやり直す。"
                            : "既知正常版へ別の試行で戻す。元更新の失敗を成功に変更しない。"}{" "}
                          各1回・15分/256
                          MiBの予算とrelease/署名/停止確認をAPIで再検証する。
                        </p>
                      </>
                    }
                  />
                ))}
              </div>
              {t.attempts.map((attempt) => (
                <section key={attempt.attemptId}>
                  <h4>
                    試行{attempt.ordinal} / {attempt.purpose}
                  </h4>
                  <p>
                    attemptId: {attempt.attemptId}
                    <br />
                    前attempt: {attempt.previousAttemptId ?? "なし"}
                    <br />
                    commandId: {attempt.commandId} / fence: {attempt.fence}
                  </p>
                  <p>
                    開始 {otaTime(attempt.startedAt)} / 開始期限{" "}
                    {otaTime(attempt.expiresAt)} / 結果期限{" "}
                    {otaTime(attempt.resultDeadline)}
                  </p>
                  <p>
                    health鮮度（照会時）:{" "}
                    {attempt.freshHealth ? "新鮮" : "未確認または古い"}
                  </p>
                  <h5>評価履歴（直近20件）</h5>
                  <ul>
                    {attempt.evaluations.map((e) => (
                      <li key={e.evaluationId}>
                        {otaLabel(e.status)} / {e.reason} /{" "}
                        {otaTime(e.evaluatedAt)}
                        <p>
                          根拠:{" "}
                          {e.evidence.map((id) =>
                            attempt.events.some(
                              (event) => event.eventId === id,
                            ) ? (
                              <a key={id} href={`#event-${id}`}>
                                {id}{" "}
                              </a>
                            ) : (
                              <span key={id}>
                                {id}（表示範囲外・API照会を参照）{" "}
                              </span>
                            ),
                          )}
                        </p>
                      </li>
                    ))}
                  </ul>
                  <h5>
                    保存イベント（今回の取得範囲: {attempt.events.length}件）
                  </h5>
                  {attempt.eventsTruncated && (
                    <p>
                      表示上限を超える根拠があります。この不完全な表示から復旧は承認できません。画面上部で100件まで読み直せます。
                    </p>
                  )}
                  <ul>
                    {attempt.events.map((e) => (
                      <li key={e.eventId} id={`event-${e.eventId}`}>
                        <p>
                          {String(e.payload.type)} / {e.acceptance} /{" "}
                          {e.reason ?? "理由なし"} / {e.eventId}
                        </p>
                        <p>
                          端末 {otaTime(e.occurredAt)} / 受信{" "}
                          {otaTime(e.receivedAt)} / 保存 {otaTime(e.storedAt)}
                        </p>
                        <details>
                          <summary>イベント内容</summary>
                          <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                  <h5>拒否・衝突の診断（直近20件）</h5>
                  <ul>
                    {attempt.rejections.map((r) => (
                      <li key={r.rejectionId}>
                        {r.reason} / {otaTime(r.receivedAt)}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <a
                href={`${base}/deployments/${data.deploymentId}?eventLimit=100`}
                target="_blank"
                rel="noreferrer"
              >
                最大100件の根拠をAPIで照会（別タブ）
              </a>
            </>
          )}
        </details>
      </td>
    </tr>
  );
}
function Interventions({
  base,
  data,
  now,
  disabled,
  preview,
}: {
  base: string;
  data: Deployment;
  now: number;
  disabled: boolean;
  preview: Preview;
}) {
  const [cursors, setCursors] = useState<
    ({ startedAt: string; interventionId: string } | undefined)[]
  >([undefined]);
  const query = useQuery({
    queryKey: ["ota-interventions", base, data.deploymentId, cursors.at(-1)],
    queryFn: ({ signal }) =>
      fetchInterventions(base, data.deploymentId, cursors.at(-1), signal),
    retry: false,
    refetchInterval: 5000,
  });
  return (
    <section aria-label="介入履歴">
      {query.isPending && <p role="status">介入履歴を取得中…</p>}
      {query.isError && (
        <p role="alert">
          介入履歴を取得できません。
          <button type="button" onClick={() => void query.refetch()}>
            介入履歴を再取得
          </button>
        </p>
      )}
      {query.data?.items.length === 0 && <p>介入記録はありません。</p>}
      <ul className="ota-records">
        {query.data?.items.map((i) => (
          <li key={i.interventionId}>
            <p>
              {i.category === "REQUIRED_APPROVAL"
                ? "必須の段階承認"
                : "障害への人間対応"}{" "}
              / {i.kind} / {i.operationResult}
            </p>
            <p>
              interventionId: {i.interventionId} / 理由: {i.reason} / actor:
              anonymous（本人・承認権限未確認）
            </p>
            <p>
              受付開始 {otaTime(i.startedAt)} / 受付終了 {otaTime(i.finishedAt)}{" "}
              / 作業時間{" "}
              {i.durationMs === null
                ? "未取得"
                : `${i.durationMs}ms（自己申告）`}{" "}
              / 費用 {i.cost ? `${i.cost.amount} ${i.cost.currency}` : "未取得"}
            </p>
            <p>
              受付の経過時間は人間の実作業時間ではない。対応終了は端末停止・回復成功・予約解放を意味しない。
            </p>
            <Link to={`/audit-logs/${i.auditEventId}`}>
              開始・操作の監査ログ
            </Link>
            {i.completionAuditEventId && (
              <>
                {" "}
                /{" "}
                <Link to={`/audit-logs/${i.completionAuditEventId}`}>
                  終了の監査ログ
                </Link>
              </>
            )}
            {i.completionReason && <p>終了判断理由: {i.completionReason}</p>}
            {i.recoveryId && (
              <p>
                <a href={`#recovery-${i.recoveryId}`}>関連する復旧結果</a>
              </p>
            )}
            {i.resolutionRecoveryId && (
              <p>
                <a href={`#recovery-${i.resolutionRecoveryId}`}>
                  引き継いだ復旧要求
                </a>
              </p>
            )}
            <details>
              <summary>対象・試行snapshot</summary>
              <pre>{JSON.stringify(i.scope, null, 2)}</pre>
            </details>
            {i.kind === "HUMAN_REVIEW" && i.finishedAt === null && (
              <ReviewEnd
                intervention={i}
                data={data}
                now={now}
                disabled={disabled || query.isError || query.isFetching}
                preview={preview}
              />
            )}
          </li>
        ))}
      </ul>
      <nav aria-label="介入履歴のページ">
        <button
          type="button"
          disabled={cursors.length === 1 || query.isFetching}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          新しい介入ページ
        </button>
        <button
          type="button"
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => setCursors([...cursors, query.data!.nextCursor!])}
        >
          以前の介入ページ
        </button>
      </nav>
    </section>
  );
}
function ReviewEnd({
  intervention: i,
  data,
  now,
  disabled,
  preview,
}: {
  intervention: Intervention;
  data: Deployment;
  now: number;
  disabled: boolean;
  preview: Preview;
}) {
  const [reason, setReason] = useState(""),
    [outcome, setOutcome] = useState<
      "KEEP_STOPPED" | "ESCALATED" | "RECOVERY_REQUESTED"
    >("KEEP_STOPPED"),
    [recoveryId, setRecoveryId] = useState(""),
    [duration, setDuration] = useState("");
  const durationMs =
    duration === ""
      ? undefined
      : /^\d+$/.test(duration)
        ? Number(duration)
        : NaN;
  const recoveryValid =
    outcome !== "RECOVERY_REQUESTED" ||
    data.recoveries.some(
      (r) =>
        r.recoveryId === recoveryId &&
        r.attemptId !== null &&
        Date.parse(r.approvedAt) >= Date.parse(i.startedAt),
    );
  const invalid =
    !reasonCode.safeParse(reason).success ||
    (durationMs !== undefined &&
      (!Number.isSafeInteger(durationMs) ||
        durationMs > now - Date.parse(i.startedAt))) ||
    !recoveryValid;
  return (
    <form
      className="group-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && !invalid)
          preview(
            {
              action: "COMPLETE_REVIEW",
              deploymentId: data.deploymentId,
              interventionId: i.interventionId,
              body: {
                reason,
                outcome,
                ...(outcome === "RECOVERY_REQUESTED" ? { recoveryId } : {}),
                ...(durationMs === undefined ? {} : { durationMs }),
              },
            },
            <>
              <p>
                判断対応: {i.interventionId} / 方針: {outcome}
              </p>
              <p>
                対応判断の終了だけを記録し、停止latch・予約・評価を解除しない。
              </p>
            </>,
          );
      }}
    >
      <h4>判断対応の終了を記録</h4>
      <label>
        終了判断
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          disabled={disabled}
        >
          <option value="KEEP_STOPPED">停止を維持する</option>
          <option value="ESCALATED">現地調査等へ引き継ぐ</option>
          <option value="RECOVERY_REQUESTED">承認済み復旧要求へ引き継ぐ</option>
        </select>
      </label>
      {outcome === "RECOVERY_REQUESTED" && (
        <label>
          引継ぎ先の復旧要求
          <select
            value={recoveryId}
            onChange={(e) => setRecoveryId(e.target.value)}
            disabled={disabled}
          >
            <option value="">選択してください</option>
            {data.recoveries
              .filter(
                (r) =>
                  r.attemptId !== null &&
                  Date.parse(r.approvedAt) >= Date.parse(i.startedAt),
              )
              .map((r) => (
                <option key={r.recoveryId} value={r.recoveryId}>
                  {r.kind} / {r.recoveryId}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        終了理由コード
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={64}
          disabled={disabled}
        />
      </label>
      <label>
        実作業時間ms（取得した場合だけ・任意）
        <input
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          inputMode="numeric"
          maxLength={16}
          disabled={disabled}
        />
      </label>
      <p>
        空欄は未取得。受付開始からの経過時間を超える自己申告値は送信できない。
      </p>
      <button type="submit" disabled={disabled || invalid}>
        判断対応終了を確認
      </button>
    </form>
  );
}
