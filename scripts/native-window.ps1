[CmdletBinding()]
param()

# 原生窗口探针：常驻一个 PowerShell，按行读 JSON 请求、按行回 JSON（scripts/native-window.ts 驱动）。
# 每次请求都现起一个 PowerShell 要再编译一遍 Add-Type，窗口烟测几十次探测就是几十秒；常驻只编一次。
#
# 坐标一律是物理像素：本线程先切到 Per-Monitor-V2，GetWindowRect / ClientToScreen /
# WM_NCHITTEST 拿到的都是屏幕真实像素，CSS 像素到物理像素的换算只在调用方做一次（cssPointToScreen）。

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class AtmNativeWindow
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public int Size; public Rect Monitor; public Rect Work; public uint Flags; }

    private delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint GA_PARENT = 1;
    private const uint WM_NCHITTEST = 0x0084;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const long HTTRANSPARENT = -1;

    private static void PerMonitorAware()
    {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2：不让系统按 96 DPI 虚拟化坐标。
        SetThreadDpiAwarenessContext(new IntPtr(-4));
    }

    private static string Str(string value)
    {
        var builder = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\') builder.Append('\\').Append(c);
            else if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
            else builder.Append(c);
        }
        return builder.Append('"').ToString();
    }

    private static string Box(Rect rect)
    {
        return string.Format(CultureInfo.InvariantCulture,
            "{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}}}",
            rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    private static string Bool(bool value) { return value ? "true" : "false"; }

    private static string ClassOf(IntPtr hwnd)
    {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, 256);
        return name.ToString();
    }

    public static string State(long handle)
    {
        PerMonitorAware();
        IntPtr hwnd = new IntPtr(handle);
        if (!IsWindow(hwnd)) return "{\"hwnd\":" + handle + ",\"exists\":false}";
        Rect window; GetWindowRect(hwnd, out window);
        Rect client; GetClientRect(hwnd, out client);
        Point origin = new Point { X = 0, Y = 0 };
        ClientToScreen(hwnd, ref origin);
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref info);
        return "{\"hwnd\":" + handle
            + ",\"exists\":true"
            + ",\"visible\":" + Bool(IsWindowVisible(hwnd))
            + ",\"minimized\":" + Bool(IsIconic(hwnd))
            + ",\"maximized\":" + Bool(IsZoomed(hwnd))
            + ",\"dpi\":" + GetDpiForWindow(hwnd)
            + ",\"window\":" + Box(window)
            + ",\"client\":" + Box(new Rect { Left = origin.X, Top = origin.Y, Right = origin.X + client.Right, Bottom = origin.Y + client.Bottom })
            + ",\"monitor\":" + Box(info.Monitor)
            + ",\"work\":" + Box(info.Work)
            + "}";
    }

    /// 该进程所有标题为 AyanamiTaskManager 的顶层窗口（可见与否都列出）。
    /// 不能用 MainWindowHandle：tao 事件线程那个 16×16 的窗口也带 WS_VISIBLE。
    public static string AppWindows(uint pid)
    {
        PerMonitorAware();
        var found = new List<string>();
        EnumWindows((hwnd, unused) =>
        {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != pid) return true;
            var title = new StringBuilder(64);
            GetWindowText(hwnd, title, 64);
            if (title.ToString() == "AyanamiTaskManager") found.Add(State(hwnd.ToInt64()));
            return true;
        }, IntPtr.Zero);
        return "[" + string.Join(",", found.ToArray()) + "]";
    }

    /// 物理像素的外框；x/y 为空时只改尺寸。
    public static string SetBounds(long handle, bool move, int x, int y, int width, int height)
    {
        PerMonitorAware();
        IntPtr hwnd = new IntPtr(handle);
        uint flags = SWP_NOZORDER | SWP_NOACTIVATE | (move ? 0 : SWP_NOMOVE);
        if (!SetWindowPos(hwnd, IntPtr.Zero, x, y, width, height, flags))
            throw new InvalidOperationException("SetWindowPos failed: " + Marshal.GetLastWin32Error());
        return State(handle);
    }

    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    private const uint GW_HWNDNEXT = 2;
    private const uint GW_CHILD = 5;

    private static long NcHitTest(IntPtr hwnd, long packed)
    {
        IntPtr result;
        if (SendMessageTimeout(hwnd, WM_NCHITTEST, IntPtr.Zero, new IntPtr(packed), SMTO_ABORTIFHUNG, 2000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("WM_NCHITTEST timed out on " + ClassOf(hwnd));
        return (long)(short)(result.ToInt64() & 0xffff);
    }

    /// 像系统分发鼠标那样做命中测试：从应用窗口起，每一层按 Z 序找第一个包含该点、且对
    /// WM_NCHITTEST 不回 HTTRANSPARENT 的可见子窗口，往下走到底，取最深那一层的回答。
    ///
    /// WebView2 的 app-region 不经宿主窗口：它在 WebView 里为每块 drag 区域建一个小子窗口，
    /// 那些窗口回 HTCAPTION（2）；其余位置落到渲染窗口上，回 HTCLIENT（1）。所以只对宿主
    /// 顶层窗口发 WM_NCHITTEST（Electron 时代的做法）永远是 HTCLIENT，探不出拖拽区。
    /// 不用 WindowFromPoint：那要求应用窗口在 Z 序最上面，烟测进程抢不到前台时会探到别的窗口。
    public static string HitTest(long handle, int screenX, int screenY)
    {
        PerMonitorAware();
        long packed = ((long)(screenY & 0xffff) << 16) | (uint)(screenX & 0xffff);
        var chain = new List<string>();
        IntPtr current = new IntPtr(handle);
        long hit = NcHitTest(current, packed);
        chain.Add("{\"className\":" + Str(ClassOf(current)) + ",\"hit\":" + hit + "}");
        for (int depth = 0; depth < 16; depth++)
        {
            IntPtr claimed = IntPtr.Zero;
            long claimedHit = 0;
            for (IntPtr child = GetWindow(current, GW_CHILD); child != IntPtr.Zero; child = GetWindow(child, GW_HWNDNEXT))
            {
                if (!IsWindowVisible(child)) continue;
                Rect rect; GetWindowRect(child, out rect);
                if (screenX < rect.Left || screenX >= rect.Right || screenY < rect.Top || screenY >= rect.Bottom) continue;
                long answer = NcHitTest(child, packed);
                chain.Add("{\"className\":" + Str(ClassOf(child)) + ",\"hit\":" + answer + "}");
                if (answer == HTTRANSPARENT) continue;
                claimed = child;
                claimedHit = answer;
                break;
            }
            if (claimed == IntPtr.Zero) break;
            current = claimed;
            hit = claimedHit;
        }
        return "{\"hit\":" + hit + ",\"chain\":[" + string.Join(",", chain.ToArray()) + "]}";
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo { public Point Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize; }

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, ref MinMaxInfo lParam, uint flags, uint timeout, out IntPtr result);
    private const uint WM_GETMINMAXINFO = 0x0024;

    /// 用户拖边框缩放时系统按 WM_GETMINMAXINFO 的 ptMinTrackSize 卡住窗口（SetWindowPos 不卡）。
    /// 这条系统消息跨进程由窗口管理器封送，直接问宿主要它的最小可拖尺寸（外框，物理像素）。
    public static string MinTrackSize(long handle)
    {
        PerMonitorAware();
        var info = new MinMaxInfo();
        IntPtr result;
        if (SendMessageTimeout(new IntPtr(handle), WM_GETMINMAXINFO, IntPtr.Zero, ref info, SMTO_ABORTIFHUNG, 2000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("WM_GETMINMAXINFO timed out");
        return "{\"width\":" + info.MinTrackSize.X + ",\"height\":" + info.MinTrackSize.Y + "}";
    }

    private delegate bool EnumChildProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr lParam);

    /// 诊断用：应用窗口下所有子窗口，以及它们各自对这个屏幕点的 WM_NCHITTEST。
    public static string Children(long handle, int screenX, int screenY)
    {
        PerMonitorAware();
        long packed = ((long)(screenY & 0xffff) << 16) | (uint)(screenX & 0xffff);
        var found = new List<string>();
        EnumChildWindows(new IntPtr(handle), (hwnd, unused) =>
        {
            Rect rect; GetWindowRect(hwnd, out rect);
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            IntPtr result;
            SendMessageTimeout(hwnd, WM_NCHITTEST, IntPtr.Zero, new IntPtr(packed), SMTO_ABORTIFHUNG, 2000, out result);
            found.Add("{\"hwnd\":" + hwnd.ToInt64() + ",\"parent\":" + GetAncestor(hwnd, GA_PARENT).ToInt64()
                + ",\"className\":" + Str(ClassOf(hwnd)) + ",\"pid\":" + pid
                + ",\"visible\":" + Bool(IsWindowVisible(hwnd)) + ",\"rect\":" + Box(rect)
                + ",\"hit\":" + (long)(short)(result.ToInt64() & 0xffff) + "}");
            return true;
        }, IntPtr.Zero);
        return "[" + string.Join(",", found.ToArray()) + "]";
    }
}
'@

$stdout = [Console]::Out
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    switch ($request.op) {
      "windows" { $response = [AtmNativeWindow]::AppWindows([uint32]$request.pid) }
      "state" { $response = [AtmNativeWindow]::State([long]$request.hwnd) }
      "bounds" {
        $move = $null -ne $request.PSObject.Properties["x"]
        $x = if ($move) { [int]$request.x } else { 0 }
        $y = if ($move) { [int]$request.y } else { 0 }
        $response = [AtmNativeWindow]::SetBounds([long]$request.hwnd, $move, $x, $y, [int]$request.width, [int]$request.height)
      }
      "hittest" { $response = [AtmNativeWindow]::HitTest([long]$request.hwnd, [int]$request.x, [int]$request.y) }
      "mintrack" { $response = [AtmNativeWindow]::MinTrackSize([long]$request.hwnd) }
      "children" { $response = [AtmNativeWindow]::Children([long]$request.hwnd, [int]$request.x, [int]$request.y) }
      default { throw "unknown op: $($request.op)" }
    }
    $stdout.WriteLine('{"ok":true,"value":' + $response + '}')
  } catch {
    $stdout.WriteLine('{"ok":false,"error":' + (ConvertTo-Json -Compress ([string]$_.Exception.Message)) + '}')
  }
  $stdout.Flush()
}
