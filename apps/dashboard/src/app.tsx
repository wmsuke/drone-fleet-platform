import type { ReactNode } from "react";
import { NavLink, Route, Routes } from "react-router-dom";

import { DeviceDetailPage } from "./device-detail.js";
import { DeviceListPage } from "./device-list.js";
import { GroupsPage } from "./groups.js";
import { FleetOperationsPage } from "./fleet-operations.js";
import { AlertsPage } from "./alerts.js";

export interface DashboardAppProps {
  apiBaseUrl: string | null;
}

function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Fleet operations</p>
          <h1>Drone Fleet Platform</h1>
        </div>
        <nav aria-label="メインナビゲーション">
          <NavLink to="/">ダッシュボード</NavLink>
          <NavLink to="/groups">機体グループ</NavLink>
          <NavLink to="/fleet-operations">グループ操作</NavLink>
          <NavLink to="/alerts">alert</NavLink>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}

function HomePage({ apiBaseUrl }: { apiBaseUrl: string | null }) {
  return (
    <section className="panel" aria-labelledby="dashboard-title">
      <p className="eyebrow">Overview</p>
      <h2 id="dashboard-title">機体一覧</h2>
      <p className="lead">接続状態と最新の運航状況を5秒ごとに更新する。</p>
      {apiBaseUrl === null ? (
        <div className="notice notice-error" role="alert">
          <strong>API接続先が設定されていません。</strong>
          <span>
            VITE_API_BASE_URLを設定して開発サーバーを再起動してください。
          </span>
        </div>
      ) : (
        <DeviceListPage apiBaseUrl={apiBaseUrl} />
      )}
    </section>
  );
}

function NotFoundPage() {
  return (
    <section className="panel">
      <p className="eyebrow">404</p>
      <h2>ページが見つかりません</h2>
      <NavLink className="text-link" to="/">
        ダッシュボードへ戻る
      </NavLink>
    </section>
  );
}

export function DashboardApp({ apiBaseUrl }: DashboardAppProps) {
  return (
    <Layout>
      <Routes>
        <Route
          path="/alerts"
          element={<AlertsPage apiBaseUrl={apiBaseUrl} />}
        />
        <Route
          path="/alerts/:alertId"
          element={<AlertsPage apiBaseUrl={apiBaseUrl} />}
        />
        <Route
          path="/fleet-operations"
          element={<FleetOperationsPage apiBaseUrl={apiBaseUrl} />}
        />
        <Route
          path="/fleet-operations/:operationId"
          element={<FleetOperationsPage apiBaseUrl={apiBaseUrl} />}
        />
        <Route path="/" element={<HomePage apiBaseUrl={apiBaseUrl} />} />
        <Route
          path="/groups"
          element={<GroupsPage apiBaseUrl={apiBaseUrl} />}
        />
        <Route
          path="/groups/:groupId"
          element={<GroupsPage apiBaseUrl={apiBaseUrl} />}
        />
        <Route
          path="/devices/:deviceId"
          element={<DeviceDetailPage apiBaseUrl={apiBaseUrl} />}
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}
