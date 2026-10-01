/**
 * 窗口关掉之后把界面用过的内存还回去（ATM-T-0523）。
 *
 * 打开窗口时首屏会把一批项目库拉进连接池，各库的 SQLite 页缓存在 V8 堆外；界面那批请求也把
 * V8 堆撑大。这两样窗口关了都不会自己还：实测关窗后常驻内存比开窗前高约 50 MiB，关开几次
 * 就越过 200 MiB 的后台门。关窗后稍等（界面最后的请求落地）再释放；窗口在这之前又开了就不做。
 */
export class WindowMemoryRelease {
  readonly #delayMs: number;
  readonly #release: () => void;
  #timer: NodeJS.Timeout | null = null;

  constructor(input: { delayMs: number; release: () => void }) {
    this.#delayMs = input.delayMs;
    this.#release = input.release;
  }

  windowShown(): void {
    this.cancel();
  }

  windowClosed(): void {
    this.cancel();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#release();
    }, this.#delayMs);
    this.#timer.unref();
  }

  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
