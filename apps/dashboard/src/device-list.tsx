import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { fetchDevices, type DeviceListItem } from "./api.js";

export const DEVICE_REFRESH_INTERVAL_MS = 5_000;

const flightStatusLabels: Record<
  NonNullable<DeviceListItem["flightStatus"]>,
  string
> = {
  IDLE: "待機",
  FLYING: "飛行中",
  RETURNING_HOME: "帰還中",
};

function formatBattery(battery: number | null): string {
  return battery === null
    ? "未取得"
    : `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(battery)}%`;
}

function formatLastReceivedAt(lastReceivedAt: string | null): string {
  if (lastReceivedAt === null) {
    return "未受信";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(lastReceivedAt));
}

function Summary({ devices }: { devices: DeviceListItem[] }) {
  const online = devices.filter(
    ({ connectionStatus }) => connectionStatus === "ONLINE",
  ).length;
  const items = [
    { label: "総台数", value: devices.length },
    { label: "オンライン", value: online },
    { label: "オフライン", value: devices.length - online },
  ];

  return (
    <dl className="summary-grid" aria-label="機体数の集計">
      {items.map(({ label, value }) => (
        <div className="summary-card" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DeviceCard({ device }: { device: DeviceListItem }) {
  const isOnline = device.connectionStatus === "ONLINE";
  return (
    <article className="device-card">
      <div className="device-card-header">
        <div>
          <p className="device-label">Device</p>
          <h3>{device.deviceId}</h3>
        </div>
        <span
          className={`status-badge ${isOnline ? "status-online" : "status-offline"}`}
        >
          <span aria-hidden="true" className="status-dot" />
          {isOnline ? "オンライン" : "オフライン"}
        </span>
      </div>
      <dl className="device-metrics">
        <div>
          <dt>バッテリー</dt>
          <dd>{formatBattery(device.battery)}</dd>
        </div>
        <div>
          <dt>飛行状態</dt>
          <dd>
            {device.flightStatus === null
              ? "未取得"
              : flightStatusLabels[device.flightStatus]}
          </dd>
        </div>
        <div className="metric-wide">
          <dt>最終受信</dt>
          <dd>
            <time dateTime={device.lastReceivedAt ?? undefined}>
              {formatLastReceivedAt(device.lastReceivedAt)}
            </time>
          </dd>
        </div>
      </dl>
      <Link className="device-link" to={`/devices/${device.deviceId}`}>
        機体詳細を見る
        <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export function DeviceListPage({ apiBaseUrl }: { apiBaseUrl: string }) {
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: ({ signal }) => fetchDevices(apiBaseUrl, signal),
    refetchInterval: DEVICE_REFRESH_INTERVAL_MS,
    retry: false,
  });

  if (devices.isPending) {
    return <p className="notice">機体情報を読み込んでいます…</p>;
  }
  if (devices.isError) {
    return (
      <div className="notice notice-error" role="alert">
        <strong>機体情報を取得できませんでした。</strong>
        <span>APIの起動状態を確認して、もう一度お試しください。</span>
        <button type="button" onClick={() => void devices.refetch()}>
          再試行
        </button>
      </div>
    );
  }
  return (
    <>
      <Summary devices={devices.data} />
      {devices.data.length === 0 ? (
        <div className="empty-state">
          <strong>登録済みの機体はありません。</strong>
          <span>テレメトリを受信すると、機体がここに表示されます。</span>
        </div>
      ) : (
        <div className="device-grid" aria-label="機体一覧">
          {devices.data.map((device) => (
            <DeviceCard device={device} key={device.deviceId} />
          ))}
        </div>
      )}
    </>
  );
}
