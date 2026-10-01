import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { DashboardApp } from "./app.js";
import { normalizeApiBaseUrl } from "./api.js";
import "./styles.css";

const queryClient = new QueryClient();
const root = document.getElementById("root");
if (root === null) {
  throw new Error("root element not found");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DashboardApp
          apiBaseUrl={normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL)}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
