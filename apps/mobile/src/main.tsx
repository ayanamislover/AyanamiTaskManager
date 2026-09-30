import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ayanami-task/ui/tokens.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles/overlays.css";
import "./styles/screens.css";
import "./styles/lists.css";
import "./styles/detail.css";
import { App } from "./app.js";
import { installTheme } from "./ui/theme.js";

installTheme();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
