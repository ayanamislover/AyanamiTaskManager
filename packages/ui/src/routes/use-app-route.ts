import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopBridge, Route } from "../contracts.js";

export function useAppRouteState() {
  return useState<Route>(() => (location.hash.slice(1) as Route) || "overview");
}

export function useRouteHash(route: Route): void {
  useEffect(() => {
    location.hash = route;
  }, [route]);
}

export function useDesktopRouteNavigation(
  desktop: DesktopBridge | undefined,
  setRoute: Dispatch<SetStateAction<Route>>,
): void {
  useEffect(() => desktop?.onNavigate?.((next) => setRoute(next as Route)), [desktop]);
}

export function appRouteTitle(route: Route, projectName?: string | null): string {
  return (
    projectName ??
    (
      {
        overview: "总览",
        projects: "项目",
        my: "活动任务",
        quick: "临时任务",
        blockers: "阻塞与等待",
        agents: "Agent",
        timeline: "全局时间线",
        settings: "设置",
      } as Record<string, string>
    )[route] ??
    "工作区"
  );
}
