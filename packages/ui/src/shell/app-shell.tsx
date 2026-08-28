import type { ComponentProps, ReactNode } from "react";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/icons/MagnifyingGlass";
import { MoonIcon as Moon } from "@phosphor-icons/react/dist/icons/Moon";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { SunIcon as Sun } from "@phosphor-icons/react/dist/icons/Sun";
import type { Route, Theme } from "../contracts.js";
import { Sidebar } from "./sidebar.js";

export function AppShell({
  route,
  onRoute,
  projects,
  brandLogoSrc,
  title,
  theme,
  statusSlot,
  content,
  paletteSlot,
  drawerSlot,
  noticeSlot,
  onSearch,
  onToggleTheme,
  onCreate,
}: {
  route: Route;
  onRoute: (route: Route) => void;
  projects: ComponentProps<typeof Sidebar>["projects"];
  brandLogoSrc?: string;
  title: string;
  theme: Theme;
  statusSlot: ReactNode;
  content: ReactNode;
  paletteSlot?: ReactNode;
  drawerSlot?: ReactNode;
  noticeSlot?: ReactNode;
  onSearch: () => void;
  onToggleTheme: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="atm-shell">
      <Sidebar
        route={route}
        setRoute={onRoute}
        projects={projects}
        {...(brandLogoSrc ? { brandLogoSrc } : {})}
      />
      <main className="atm-main">
        <header className="atm-topbar">
          <div className="atm-breadcrumb">{title}</div>
          <button className="atm-search-button" onClick={onSearch}>
            <MagnifyingGlass size={17} />
            搜索任务、记录和项目<kbd>Ctrl K</kbd>
          </button>
          <div className="atm-top-actions" data-testid="window-drag-actions">
            <button
              className="atm-button atm-icon-button atm-theme-toggle"
              aria-label={theme === "light" ? "切换至暗黑模式" : "切换至亮色模式"}
              title={theme === "light" ? "切换至暗黑模式" : "切换至亮色模式"}
              onClick={onToggleTheme}
            >
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <button className="atm-button" onClick={onCreate}>
              <Plus size={16} />
              {route.startsWith("project:") ? "新建任务" : "临时任务"}
              <kbd>Ctrl N</kbd>
            </button>
            {statusSlot}
          </div>
        </header>
        <div className="atm-content">{content}</div>
      </main>
      {paletteSlot}
      {drawerSlot}
      {noticeSlot ? (
        <div className="atm-notice" role="status">
          {noticeSlot}
        </div>
      ) : null}
    </div>
  );
}
