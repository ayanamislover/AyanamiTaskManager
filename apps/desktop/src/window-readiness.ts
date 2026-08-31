export type WindowReadinessAction = {
  show: true;
  route: string | null;
};

/**
 * 等渲染器报到的上限。正常冷启动远快于此；这个值只用来兜住渲染器根本不会报到的情况。
 */
export const RENDERER_READY_TIMEOUT_MS = 10_000;

export class WindowReadinessGate {
  private windowReady = false;
  private rendererReady = false;
  private rendererAbandoned = false;
  private showPending = false;
  private routePending: string | null = null;

  reset(showWhenReady: boolean): void {
    this.windowReady = false;
    this.rendererReady = false;
    this.rendererAbandoned = false;
    this.showPending = showWhenReady;
    this.routePending = null;
  }

  get abandoned(): boolean {
    return this.rendererAbandoned;
  }

  requestShow(): WindowReadinessAction | null {
    this.showPending = true;
    return this.drain();
  }

  requestNavigation(route: string): WindowReadinessAction | null {
    this.showPending = true;
    this.routePending = route;
    return this.drain();
  }

  markWindowReady(): WindowReadinessAction | null {
    this.windowReady = true;
    return this.drain();
  }

  markRendererReady(): WindowReadinessAction | null {
    this.rendererReady = true;
    return this.drain();
  }

  /**
   * 渲染器不会再报到了：加载失败、渲染进程退出，或等待超时。
   *
   * 门控要保证的是「不显示空白窗口」，不是「永远不显示窗口」。托盘菜单、托盘点击、
   * 第二实例和 activate 全都挂在 rendererReady 上，一直不放行等于应用只剩一个点不动的
   * 托盘图标，用户没有任何出路——那比看到一个能关掉的空窗口更糟。
   *
   * 放行不等于弹窗：是否真的显示仍由 showPending 决定，所以后台启动照旧保持隐藏，
   * 只是把托盘重新变回可用。
   */
  markRendererUnavailable(): WindowReadinessAction | null {
    if (this.rendererReady) return null;
    this.rendererAbandoned = true;
    this.rendererReady = true;
    return this.drain();
  }

  private drain(): WindowReadinessAction | null {
    if (!this.windowReady || !this.rendererReady || !this.showPending) return null;
    const action: WindowReadinessAction = {
      show: true,
      route: this.routePending,
    };
    this.showPending = false;
    this.routePending = null;
    return action;
  }
}
