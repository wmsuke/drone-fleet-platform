import type { Deployment, Target, Intent } from "./ota-api.js";

const sameRelease = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  ["releaseId", "version", "digest", "buildId"].every((k) => a[k] === b[k]);
const fresh = (timestamp: string, now: number) =>
  now >= Date.parse(timestamp) && now - Date.parse(timestamp) < 15000;
const freshHealth = (t: Target, now: number) => {
  const a = t.attempts[0]!,
    event = a.events.find(
      (e) => e.acceptance === "ACCEPTED" && e.payload.type === "HEALTH",
    );
  return a.freshHealth && !!event && fresh(event.storedAt, now);
};
export function recoveryBlock(
  d: Deployment,
  t: Target,
  kind: "RETRY" | "ROLLBACK",
  now: number,
): string | null {
  const a = t.attempts[0]!,
    root = t.attempts[t.attempts.length - 1]!,
    observation = t.observation,
    i = observation?.payload,
    local = i?.recovery;
  if (d.status !== "PAUSED")
    return "停止確認済み（PAUSED）でのみ復旧を承認できます";
  if (
    a.evaluationStatus !== "FAILED" ||
    a.eventsTruncated ||
    t.attempts.some(
      (v) => v.eventsTruncated || v.evaluationStatus === "UNCERTAIN",
    )
  )
    return "前試行の失敗・全根拠を確認できません。結果不明では再適用できません";
  const prior = d.recoveries.filter((r) => r.targetId === t.targetId);
  if (prior.some((r) => ["WAITING", "RUNNING"].includes(r.status)))
    return "復旧を実行中です";
  if (
    prior.some(
      (r) =>
        (r.kind === kind && r.attemptId !== null) ||
        (r.kind === "ROLLBACK" && ["FAILED", "UNCERTAIN"].includes(r.status)),
    )
  )
    return "復旧回数または再帰的rollbackの制限に達しています";
  if (
    !i ||
    !local ||
    !t.current ||
    !fresh(observation!.receivedAt, now) ||
    !fresh(t.current.observedAt, now) ||
    local.attemptId !== a.attemptId ||
    i.running.bootId !== t.current.bootId ||
    !sameRelease(i.running.release, t.current) ||
    !["FAILED", "STOPPED", "APPLIED"].includes(local.phase)
  )
    return "現在の版・boot・終端・復旧予算を新鮮な観測で確認できません";
  const keys =
    kind === "RETRY"
      ? ([
          "eventLoop",
          "telemetry",
          "sqlite",
          "commandReady",
          "mqtt",
          "subscriptions",
          "receipts",
        ] as const)
      : (["eventLoop", "sqlite", "mqtt", "subscriptions", "receipts"] as const);
  if (!i.readiness || keys.some((k) => i.readiness![k] !== "PASSED"))
    return "復旧に必要なreadinessを確認できません";
  const facts = a.events.filter((e) => e.acceptance === "ACCEPTED"),
    terminal = facts.find((e) => e.payload.type === "STATE"),
    state = terminal?.payload;
  const running = state?.running as {
    bootId?: string;
    release?: Record<string, unknown>;
  } | null;
  if (
    !state ||
    !["FAILED", "STOPPED", "APPLIED"].includes(String(state.state)) ||
    !running?.release ||
    running.bootId !== i.running.bootId ||
    state.supervisorBootId !== i.supervisorBootId ||
    !sameRelease(running.release, i.running.release) ||
    facts.some((e) => e.payload.state === "UNCERTAIN")
  )
    return "前試行の直接STATE終端と現在版が一致しません";
  const failures = root.evaluations.filter((e) =>
    ["FAILED", "UNCERTAIN"].includes(e.status),
  );
  if (
    !failures.length ||
    !local.detectedAt ||
    !local.budgetDeadline ||
    Date.parse(local.detectedAt) > now ||
    Date.parse(local.budgetDeadline) - Date.parse(local.detectedAt) !== 900000
  )
    return "障害検出時刻・総予算が未確認です";
  const deadline = Math.min(
    Date.parse(local.budgetDeadline),
    ...failures.map((e) => Date.parse(e.evaluatedAt) + 900000),
  );
  if (deadline <= now + (kind === "RETRY" ? 660000 : 600000))
    return "復旧の結果確認期間を確保できません";
  let observedBytes = 0;
  for (const attempt of t.attempts)
    observedBytes += Math.max(
      0,
      ...attempt.events
        .filter(
          (e) => e.acceptance === "ACCEPTED" && e.payload.type === "PROGRESS",
        )
        .map((e) => Number(e.payload.downloadedBytes) || 0),
    );
  if (
    local.downloadedBytes < observedBytes ||
    local.downloadedBytes >= 268435456
  )
    return "転送予算が不足または整合していません";
  if (kind === "RETRY") {
    if (
      !sameRelease(i.running.release, t.snapshot) ||
      !facts.some(
        (e) =>
          e.payload.type === "PROGRESS" &&
          e.payload.state === "FAILED" &&
          e.payload.reason === "DOWNLOAD_FAILED",
      ) ||
      facts.some(
        (e) =>
          e.payload.type === "VERSION" ||
          (e.payload.type === "PROGRESS" &&
            [
              "VERIFIED",
              "QUIESCING",
              "SWITCHING",
              "BOOTING",
              "HEALTH_CHECKING",
              "APPLIED",
            ].includes(String(e.payload.state))),
      )
    )
      return "適用前の一時的download失敗だけを再試行できます";
  } else if (
    !sameRelease(i.running.release, d.releaseSnapshot.manifest) ||
    !sameRelease(local.knownGood, t.snapshot) ||
    sameRelease(local.knownGood, i.running.release) ||
    !d.releaseSnapshot.manifest.rollbackCompatible
  )
    return "既知正常版・現行版・rollback互換性が未確認です";
  return null;
}
export function actionBlock(
  i: Intent,
  d: Deployment | undefined,
  now: number,
): string | null {
  if (i.action === "CREATE") return null;
  if (!d || d.deploymentId !== i.deploymentId) return "配信情報が未確認です";
  if (i.action === "COMPLETE_REVIEW") return null;
  if (i.action === "START_REVIEW")
    return ["PAUSED", "WAITING_FOR_HUMAN"].includes(d.status) &&
      d.interventionSummary.openReviewCount === 0
      ? null
      : "判断対応を開始できる状態ではありません";
  if (i.action === "STOP")
    return ["COMPLETED", "FAILED", "CANCELLED"].includes(d.status)
      ? "終了した配信は停止できません"
      : null;
  if (i.action === "RETRY" || i.action === "ROLLBACK") {
    const t = d.targets.find((t) => t.targetId === i.targetId);
    return t ? recoveryBlock(d, t, i.action, now) : "対象が見つかりません";
  }
  if (i.action === "APPROVE") {
    const s = d.stages.find((s) => s.stageId === i.stageId);
    if (
      !s ||
      s.status !== "AWAITING_APPROVAL" ||
      !["ACCEPTED", "RUNNING"].includes(d.status) ||
      d.control?.stoppedAt
    )
      return "承認待ちではないか配信が停止中です";
    if (
      d.stages.some(
        (v) =>
          v.position < s.position &&
          (v.status !== "PASSED" ||
            (v.counts.SUCCEEDED ?? 0) !== v.denominator ||
            d.targets
              .filter((t) => t.stageId === v.stageId)
              .some(
                (t) =>
                  t.attempts[0]!.purpose !== "APPLY" ||
                  t.attempts[0]!.evaluationStatus !== "SUCCEEDED" ||
                  !freshHealth(t, now) ||
                  !t.current ||
                  !fresh(t.current.observedAt, now),
              )),
      )
    )
      return "先行段階の全対象成功・新鮮なhealthを確認できません";
    if (
      d.targets
        .filter((t) => t.stageId === s.stageId)
        .some(
          (t) =>
            t.attempts[0]!.deliveryStatus !== "HELD" ||
            !t.current ||
            !fresh(t.current.observedAt, now),
        )
    )
      return "承認対象の未解禁試行・新鮮な現在状態を確認できません";
    return null;
  }
  if (
    d.status !== "PAUSED" ||
    !d.control?.stoppedAt ||
    d.targets.some((t) => {
      const a = t.attempts[0]!;
      return (
        a.purpose === "ROLLBACK" ||
        a.stop ||
        ["FAILED", "UNCERTAIN"].includes(a.evaluationStatus) ||
        (a.expiresAt &&
          a.evaluationStatus !== "SUCCEEDED" &&
          now >= Date.parse(a.expiresAt)) ||
        !t.current ||
        !fresh(t.current.observedAt, now) ||
        (a.evaluationStatus === "SUCCEEDED" && !freshHealth(t, now)) ||
        (a.evaluationStatus !== "SUCCEEDED" &&
          (!t.observation ||
            !fresh(t.observation.receivedAt, now) ||
            t.observation.payload.running.bootId !== t.current?.bootId ||
            !sameRelease(t.observation.payload.running.release, t.current) ||
            !t.observation.payload.readiness ||
            Object.values(t.observation.payload.readiness).some(
              (v) => v !== "PASSED",
            )))
      );
    })
  )
    return "停止確認・元期限・現在状態が不足しています。失敗/結果不明の同じ試行は再開できません";
  return null;
}
