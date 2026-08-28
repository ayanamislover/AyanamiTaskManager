import { useEffect, useState } from "react";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/icons/CaretRight";
import { CheckSquareIcon as CheckSquare } from "@phosphor-icons/react/dist/icons/CheckSquare";
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from "@phosphor-icons/react/dist/icons/ClockCounterClockwise";
import { FolderOpenIcon as FolderOpen } from "@phosphor-icons/react/dist/icons/FolderOpen";
import { GearSixIcon as GearSix } from "@phosphor-icons/react/dist/icons/GearSix";
import { HouseIcon as House } from "@phosphor-icons/react/dist/icons/House";
import { LightningIcon as Lightning } from "@phosphor-icons/react/dist/icons/Lightning";
import { UsersThreeIcon as UsersThree } from "@phosphor-icons/react/dist/icons/UsersThree";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/icons/WarningCircle";
import type { RegisteredProject } from "@ayanami-task/client";
import type { Route } from "../contracts.js";
import { sidebarProjectHint } from "../presentation.js";

export function Sidebar({
  route,
  setRoute,
  projects,
  brandLogoSrc,
}: {
  route: Route;
  setRoute: (route: Route) => void;
  projects: RegisteredProject[];
  brandLogoSrc?: string;
}) {
  const primary = [
    ["overview", "总览", House],
    ["projects", "项目", FolderOpen],
  ] as const;
  const workspace = [
    ["my", "活动任务", CheckSquare],
    ["quick", "临时任务", Lightning],
    ["blockers", "阻塞与等待", WarningCircle],
    ["agents", "Agent", UsersThree],
    ["timeline", "全局时间线", ClockCounterClockwise],
  ] as const;
  const routeUsesWorkspace = workspace.some(([key]) => route === key);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(() => {
    if (routeUsesWorkspace) return true;
    return window.localStorage.getItem("atm.workspace.expanded") === "true";
  });
  useEffect(() => {
    if (routeUsesWorkspace) setWorkspaceExpanded(true);
  }, [routeUsesWorkspace]);
  useEffect(() => {
    window.localStorage.setItem("atm.workspace.expanded", String(workspaceExpanded));
  }, [workspaceExpanded]);
  return (
    <aside className="atm-sidebar">
      <div className="atm-sidebar-inner">
        <div className="atm-brand" data-testid="window-drag-brand">
          <span className="atm-brand-mark">
            {brandLogoSrc ? (
              <img src={brandLogoSrc} alt="" aria-hidden="true" />
            ) : (
              <CheckSquare size={18} weight="bold" />
            )}
          </span>
          <span>AyanamiTaskManager</span>
        </div>
        <div className="atm-nav-group atm-primary-navigation">
          <nav className="atm-nav" aria-label="主导航">
            {primary.map(([key, label, Icon]) => (
              <button
                key={key}
                aria-current={route === key ? "page" : undefined}
                onClick={() => setRoute(key)}
              >
                <Icon size={18} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="atm-nav-group atm-workspace-navigation">
          <button
            type="button"
            className="atm-nav-disclosure"
            aria-expanded={workspaceExpanded}
            aria-controls="atm-workspace-navigation"
            onClick={() => setWorkspaceExpanded((expanded) => !expanded)}
          >
            <CaretRight size={16} aria-hidden="true" />
            <span>工作区</span>
          </button>
          <nav
            className="atm-nav atm-nav-secondary"
            id="atm-workspace-navigation"
            aria-label="工作区"
            hidden={!workspaceExpanded}
          >
            {workspace.map(([key, label, Icon]) => (
              <button
                key={key}
                aria-current={route === key ? "page" : undefined}
                onClick={() => setRoute(key)}
              >
                <Icon size={18} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>
        {projects.length ? (
          <div className="atm-nav-group">
            <div className="atm-nav-title">活动项目</div>
            <nav className="atm-nav">
              {projects
                .filter((project) => project.lifecycle === "ACTIVE")
                .slice(0, 12)
                .map((project) => (
                  <button
                    key={project.id}
                    className="atm-nav-project"
                    aria-current={route === `project:${project.code}` ? "page" : undefined}
                    aria-label={project.name}
                    title={sidebarProjectHint(project.name)}
                    onClick={() => setRoute(`project:${project.code}`)}
                  >
                    <span className="atm-nav-project-name">{project.name}</span>
                  </button>
                ))}
            </nav>
          </div>
        ) : null}
        <div className="atm-sidebar-footer">
          <button
            type="button"
            className="atm-sidebar-settings"
            aria-current={route === "settings" ? "page" : undefined}
            onClick={() => setRoute("settings")}
          >
            <GearSix size={18} />
            <span>设置</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
