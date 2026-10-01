import type { ReactNode } from "react";
import { NavLink, Route, Routes, useParams } from "react-router-dom";

import { DeviceListPage } from "./device-list.js";

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

function DevicePage() {
  const { deviceId } = useParams();
  return (
    <section className="panel">
      <p className="eyebrow">Device</p>
      <h2>{deviceId}</h2>
      <p className="lead">機体詳細は後続Issueで実装する。</p>
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
        <Route path="/" element={<HomePage apiBaseUrl={apiBaseUrl} />} />
        <Route path="/devices/:deviceId" element={<DevicePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}
