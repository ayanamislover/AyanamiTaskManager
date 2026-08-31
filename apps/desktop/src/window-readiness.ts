export type WindowReadinessAction = {
  show: true;
  route: string | null;
};

export class WindowReadinessGate {
  private windowReady = false;
  private rendererReady = false;
  private showPending = false;
  private routePending: string | null = null;

  reset(showWhenReady: boolean): void {
    this.windowReady = false;
    this.rendererReady = false;
    this.showPending = showWhenReady;
    this.routePending = null;
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
