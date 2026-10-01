import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type ScreenBox = { x: number; y: number; width: number; height: number };

export type NativeWindowState = {
  hwnd: number;
  exists: boolean;
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  /** GetDpiForWindow；96 = 100%。 */
  dpi: number;
  /** 外框，物理像素。 */
  window: ScreenBox;
  /** 客户区在屏幕上的位置与尺寸，物理像素。 */
  client: ScreenBox;
  monitor: ScreenBox;
  work: ScreenBox;
};

export type NativeHitTest = {
  /** WM_NCHITTEST 的结果：1 = HTCLIENT，2 = HTCAPTION。 */
  hit: number;
  /** 从最深的子窗口往上，谁回了什么；用来定位是哪一层认领了这个点。 */
  chain: Array<{ className: string; hit: number }>;
};

export const HTCLIENT = 1;
export const HTCAPTION = 2;

/**
 * CSS 像素（Playwright boundingBox）换成屏幕物理像素，只乘一次 devicePixelRatio。
 *
 * Electron 时代的探针跑在 DPI 无感知的 PowerShell 里，靠系统把坐标虚拟化成逻辑像素，
 * 所以那时「不能再乘 DPI」。现在探针线程是 Per-Monitor-V2，拿到的客户区原点是物理像素，
 * CSS 坐标就必须在这里乘一次——乘零次在缩放屏上探错元素，乘两次同样探错。
 */
export function cssPointToScreen(
  clientOrigin: { x: number; y: number },
  cssPoint: { x: number; y: number },
  devicePixelRatio: number,
): { x: number; y: number } {
  return {
    x: Math.round(clientOrigin.x + cssPoint.x * devicePixelRatio),
    y: Math.round(clientOrigin.y + cssPoint.y * devicePixelRatio),
  };
}

const windowsPowerShell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/**
 * 原生窗口探针的客户端：常驻一个 scripts/native-window.ps1，一问一答。
 * 只读窗口状态、改外框、做命中测试；不发任何会结束进程的消息。
 */
export class NativeWindowProbe {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting: Array<(line: string) => void> = [];
  private stderr = "";
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(script: string) {
    // Windows PowerShell 5.1 把不带 BOM 的 .ps1 当 ANSI 读，中文注释会吞掉换行、把 C# 拼坏；
    // 这里显式按 UTF-8 读进来再执行，不依赖文件有没有 BOM。
    const literal = script.replaceAll("'", "''");
    this.child = spawn(
      windowsPowerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `& ([scriptblock]::Create([IO.File]::ReadAllText('${literal}', [Text.Encoding]::UTF8)))`,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) =>
      this.waiting.shift()?.(line),
    );
  }

  static start(root = process.cwd()): NativeWindowProbe {
    return new NativeWindowProbe(join(root, "scripts", "native-window.ps1"));
  }

  private request<T>(payload: Record<string, unknown>): Promise<T> {
    const next = this.queue.then(
      () =>
        new Promise<T>((resolveRequest, rejectRequest) => {
          if (this.child.exitCode !== null) {
            rejectRequest(new Error(`原生窗口探针已退出：${this.stderr}`));
            return;
          }
          // 第一次请求要等 Add-Type 编译，给足时间；之后每次都是毫秒级。
          const timer = setTimeout(
            () =>
              rejectRequest(
                new Error(`原生窗口探针超时：${JSON.stringify(payload)} ${this.stderr}`),
              ),
            30_000,
          );
          this.waiting.push((line) => {
            clearTimeout(timer);
            const response = JSON.parse(line) as { ok: boolean; value?: T; error?: string };
            if (response.ok) resolveRequest(response.value as T);
            else rejectRequest(new Error(`原生窗口探针失败：${response.error ?? line}`));
          });
          this.child.stdin.write(`${JSON.stringify(payload)}\n`);
        }),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** 宿主进程所有标题为 AyanamiTaskManager 的顶层窗口。 */
  windows(pid: number): Promise<NativeWindowState[]> {
    return this.request({ op: "windows", pid });
  }

  /** 宿主的应用窗口；窗口被关掉（WebView 一起销毁）时为 null。 */
  async appWindow(pid: number): Promise<NativeWindowState | null> {
    const windows = await this.windows(pid);
    if (windows.length > 1) throw new Error(`宿主有 ${windows.length} 个应用窗口`);
    return windows[0] ?? null;
  }

  state(hwnd: number): Promise<NativeWindowState> {
    return this.request({ op: "state", hwnd });
  }

  /** 外框，物理像素；不给 x/y 时只改尺寸。 */
  setBounds(
    hwnd: number,
    bounds: { width: number; height: number; x?: number; y?: number },
  ): Promise<NativeWindowState> {
    return this.request({ op: "bounds", hwnd, ...bounds });
  }

  /** 屏幕物理像素上的命中测试。 */
  hitTest(hwnd: number, point: { x: number; y: number }): Promise<NativeHitTest> {
    return this.request({ op: "hittest", hwnd, x: point.x, y: point.y });
  }

  /** 用户拖边框时系统允许的最小外框（WM_GETMINMAXINFO.ptMinTrackSize），物理像素。 */
  minTrackSize(hwnd: number): Promise<{ width: number; height: number }> {
    return this.request({ op: "mintrack", hwnd });
  }

  /** 诊断：应用窗口下每个子窗口对这个点的 WM_NCHITTEST，断言失败时写进报错。 */
  children(hwnd: number, point: { x: number; y: number }): Promise<unknown[]> {
    return this.request({ op: "children", hwnd, x: point.x, y: point.y });
  }

  close(): void {
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }
}
