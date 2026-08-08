import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AyanamiClient } from "@ayanami-task/client";
import { AyanamiTaskManager } from "@ayanami-task/ui";

declare global {
  interface Window {
    ayanamiDesktop?: {
      runtime: { endpoint: string; token: string };
      setAutoLaunch(enabled: boolean): Promise<boolean>;
      getAutoLaunch(): Promise<boolean>;
      showItemInFolder(path: string): Promise<void>;
      getMcpConfigs(): Promise<{
        streamableHttp: string;
        stdio: string;
        generic: string;
        agentRule: string;
      }>;
      installMcp(client: "CODEX" | "CLAUDE"): Promise<{ path: string; backupPath: string | null }>;
      copyText(text: string): Promise<boolean>;
      onNavigate(listener: (route: string) => void): () => void;
    };
  }
}

const browserEndpoint = import.meta.env.VITE_ATM_ENDPOINT as string | undefined;
const browserToken = import.meta.env.VITE_ATM_TOKEN as string | undefined;
const runtime = window.ayanamiDesktop?.runtime ?? {
  endpoint: browserEndpoint ?? "http://127.0.0.1:43127",
  token: browserToken ?? "browser-preview-token",
};
const client = new AyanamiClient(runtime);
const root = document.getElementById("root");
if (!root) throw new Error("ROOT_ELEMENT_MISSING");

createRoot(root).render(
  <StrictMode>
    <AyanamiTaskManager
      client={client}
      {...(window.ayanamiDesktop === undefined ? {} : { desktop: window.ayanamiDesktop })}
    />
  </StrictMode>,
);
