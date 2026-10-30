import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchGroups } from "./groups-api.js";
import { fetchReleases, type Intent } from "./ota-api.js";

export function OtaCreate({
  base,
  disabled,
  preview,
}: {
  base: string;
  disabled: boolean;
  preview: (intent: Intent, summary: React.ReactNode) => void;
}) {
  const releases = useQuery({
    queryKey: ["ota-releases", base],
    queryFn: ({ signal }) => fetchReleases(base, signal),
    retry: false,
  });
  const groups = useQuery({
    queryKey: ["groups", base],
    queryFn: ({ signal }) => fetchGroups(base, signal),
    retry: false,
  });
  const [releaseId, setRelease] = useState(""),
    [ids, setIds] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [sizes, setSizes] = useState(""),
    [error, setError] = useState("");
  const release = releases.data?.items.find((r) => r.releaseId === releaseId);
  return (
    <section
      className="group-form ota-create"
      aria-labelledby="ota-create-title"
    >
      <h3 id="ota-create-title">新しい配信</h3>
      <p>
        登録時に検証された最新100件のreleaseから選択する。受付時にも署名・artifact・互換性をAPIで再検証する。
      </p>
      {(releases.isError || groups.isError) && (
        <p role="alert">
          配信物またはグループを取得できません。
          <button
            type="button"
            onClick={() => {
              void releases.refetch();
              void groups.refetch();
            }}
          >
            選択肢を再取得
          </button>
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (!release || disabled || releases.isError || groups.isError)
            return;
          const direct = ids.trim() ? ids.trim().split(/[\s,]+/) : [];
          if (
            direct.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id)) ||
            new Set(direct).size !== direct.length
          ) {
            setError("機体IDの形式または重複を確認してください");
            return;
          }
          const groupMembers = (groups.data ?? [])
            .filter((g) => selected.includes(g.groupId))
            .flatMap((g) => g.deviceIds);
          const deviceIds = [...new Set([...direct, ...groupMembers])].sort();
          if (!deviceIds.length || deviceIds.length > 100) {
            setError("対象は1〜100台にしてください");
            return;
          }
          const n = sizes.trim()
            ? sizes
                .split(",")
                .map((v) => (/^\s*[1-9]\d*\s*$/.test(v) ? Number(v) : NaN))
            : [
                1,
                Math.min(3, deviceIds.length - 1),
                Math.max(0, deviceIds.length - 4),
              ].filter(Boolean);
          if (
            !n.length ||
            n.length > 10 ||
            n.some((v) => !Number.isSafeInteger(v) || v < 1) ||
            n.reduce((a, b) => a + b, 0) !== deviceIds.length
          ) {
            setError("段階台数は対象の合計と一致する1〜10段階にしてください");
            return;
          }
          let offset = 0;
          const stages = n.map((size) => {
            const members = deviceIds.slice(offset, offset + size);
            offset += size;
            return { deviceIds: members };
          });
          preview(
            {
              action: "CREATE",
              body: {
                releaseId,
                deviceIds: direct.sort(),
                groupIds: [...selected].sort(),
                stages,
              },
            },
            <>
              <p>
                配信物: {release.version} / {release.platform}
              </p>
              <p>releaseId: {releaseId}</p>
              <p>digest: {release.digest}</p>
              <p>
                buildId: {release.envelope.manifest.buildId} / 登録検証:{" "}
                {release.verifiedAt}
              </p>
              <p>
                対象: {deviceIds.length}
                台。グループ構成が変われば受付時の段階照合で拒否する。
              </p>
              <ol>
                {stages.map((s, index) => (
                  <li key={index}>
                    段階{index + 1}: {s.deviceIds.length}台 —{" "}
                    {s.deviceIds.join(", ")}
                  </li>
                ))}
              </ol>
              <p>
                全対象を予約し、承認待ちで受け付ける。先行開始も各昇格も手動承認が必要。
              </p>
            </>,
          );
        }}
      >
        <label>
          配信物
          <select
            value={releaseId}
            onChange={(e) => setRelease(e.target.value)}
            required
            disabled={disabled || releases.isPending || releases.isError}
          >
            <option value="">選択してください</option>
            {releases.data?.items.map((r) => (
              <option key={r.releaseId} value={r.releaseId}>
                {r.version} / {r.platform} / {r.releaseId}
              </option>
            ))}
          </select>
        </label>
        {releases.data?.items.length === 0 && (
          <p>配信物がありません。署名済み配信物を登録してください。</p>
        )}
        {release && (
          <p className="ota-identifier">
            版: {release.version} / digest: {release.digest} / size:{" "}
            {release.envelope.manifest.size} bytes
          </p>
        )}
        <label>
          機体ID（空白・改行・カンマ区切り）
          <textarea
            value={ids}
            onChange={(e) => setIds(e.target.value)}
            maxLength={6500}
            disabled={disabled}
          />
        </label>
        <fieldset disabled={disabled || groups.isPending || groups.isError}>
          <legend>対象グループ（任意）</legend>
          {groups.data?.map((g) => (
            <label key={g.groupId}>
              <input
                type="checkbox"
                checked={selected.includes(g.groupId)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, g.groupId]
                      : selected.filter((id) => id !== g.groupId),
                  )
                }
              />
              {g.name}（{g.deviceCount}台）
            </label>
          ))}
        </fieldset>
        <label>
          各段階の台数（任意・例: 1,3,6）
          <input
            value={sizes}
            onChange={(e) => setSizes(e.target.value)}
            maxLength={40}
            disabled={disabled}
          />
        </label>
        <p>
          省略時は機体IDのASCII順に1台 / 3台 /
          残り。全対象固定分母の失敗率10%以上、結果不明1件、integrity違反で停止する。開始300秒・結果600秒、health
          13標本/60秒、同時2台。停止条件は弱められない。
        </p>
        {error && <p role="alert">{error}</p>}
        <button
          type="submit"
          disabled={
            disabled ||
            !release ||
            releases.isError ||
            groups.isPending ||
            groups.isError
          }
        >
          対象と段階を確認
        </button>
      </form>
    </section>
  );
}
