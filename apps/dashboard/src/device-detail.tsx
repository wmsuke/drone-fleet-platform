import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { ApiError, fetchDevice, type LatestTelemetry } from "./api.js";

export const DEVICE_DETAIL_REFRESH_INTERVAL_MS = 5_000;

const flightStatusLabels: Record<LatestTelemetry["flightStatus"], string> = {
  IDLE: "待機",
  FLYING: "飛行中",
  RETURNING_HOME: "帰還中",
};

function formatNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits }).format(
    value,
  );
}

function formatTimestamp(value: string | null): string {
  if (value === null) {
    return "未受信";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function StatusBadge({ status }: { status: "ONLINE" | "OFFLINE" }) {
  const isOnline = status === "ONLINE";
  return (
    <span
      className={`status-badge ${isOnline ? "status-online" : "status-offline"}`}
    >
      <span aria-hidden="true" className="status-dot" />
      {isOnline ? "オンライン" : "オフライン"}
    </span>
  );
}

function TelemetryDetails({ telemetry }: { telemetry: LatestTelemetry }) {
  const metrics = [
    { label: "バッテリー", value: `${formatNumber(telemetry.battery, 1)} %` },
    { label: "飛行状態", value: flightStatusLabels[telemetry.flightStatus] },
    { label: "緯度", value: `${formatNumber(telemetry.latitude, 6)}°` },
    { label: "経度", value: `${formatNumber(telemetry.longitude, 6)}°` },
    { label: "高度", value: `${formatNumber(telemetry.altitude, 1)} m` },
    { label: "温度", value: `${formatNumber(telemetry.temperature, 1)} ℃` },
  ];
  return (
    <section aria-labelledby="telemetry-title">
      <div className="section-heading">
        <div>
          <p className="device-label">Latest telemetry</p>
          <h3 id="telemetry-title">最新テレメトリ</h3>
        </div>
        <span className="sequence-label">sequence {telemetry.sequence}</span>
      </div>
      <dl className="detail-grid">
        {metrics.map(({ label, value }) => (
          <div className="detail-metric" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="measurement-time">
        計測時刻:{" "}
        <time dateTime={telemetry.deviceTimestamp}>
          {formatTimestamp(telemetry.deviceTimestamp)}
        </time>
      </p>
    </section>
  );
}

export function DeviceDetailPage({
  apiBaseUrl,
}: {
  apiBaseUrl: string | null;
}) {
  const { deviceId = "" } = useParams();
  const device = useQuery({
    enabled: apiBaseUrl !== null && deviceId.length > 0,
    queryKey: ["device", deviceId],
    queryFn: ({ signal }) => fetchDevice(apiBaseUrl ?? "", deviceId, signal),
    refetchInterval: DEVICE_DETAIL_REFRESH_INTERVAL_MS,
    retry: false,
  });

  return (
    <section className="panel" aria-labelledby="device-title">
      <Link className="back-link" to="/">
        ← 機体一覧へ戻る
      </Link>
      <p className="eyebrow">Device detail</p>
      <h2 id="device-title">{deviceId}</h2>

      {apiBaseUrl === null ? (
        <div className="notice notice-error" role="alert">
          <strong>API接続先が設定されていません。</strong>
          <span>VITE_API_BASE_URLを設定してください。</span>
        </div>
      ) : device.isPending ? (
        <p className="notice">機体情報を読み込んでいます…</p>
      ) : device.isError ? (
        <div className="notice notice-error" role="alert">
          {device.error instanceof ApiError && device.error.status === 404 ? (
            <>
              <strong>機体が見つかりません。</strong>
              <span>一覧へ戻り、登録済みの機体を選択してください。</span>
            </>
          ) : (
            <>
              <strong>機体情報を取得できませんでした。</strong>
              <span>APIの起動状態を確認して、もう一度お試しください。</span>
              <button type="button" onClick={() => void device.refetch()}>
                再試行
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="detail-content">
          <div className="detail-status-row">
            <StatusBadge status={device.data.connectionStatus} />
            <span>
              最終受信:{" "}
              <time dateTime={device.data.lastReceivedAt ?? undefined}>
                {formatTimestamp(device.data.lastReceivedAt)}
              </time>
            </span>
          </div>
          <dl className="device-profile">
            <div>
              <dt>モデル</dt>
              <dd>{device.data.model ?? "未登録"}</dd>
            </div>
            <div>
              <dt>ソフトウェア</dt>
              <dd>{device.data.softwareVersion ?? "未登録"}</dd>
            </div>
          </dl>
          {device.data.latestTelemetry === null ? (
            <div className="empty-state">
              <strong>テレメトリはまだありません。</strong>
              <span>機体から最初のデータが届くまでお待ちください。</span>
            </div>
          ) : (
            <TelemetryDetails telemetry={device.data.latestTelemetry} />
          )}
        </div>
      )}
    </section>
  );
}
