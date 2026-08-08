[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][double]$ClientX,
  [Parameter(Mandatory = $true)][double]$ClientY
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AtmNativeHitTest
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    public static int Probe(long windowHandle, double clientX, double clientY)
    {
        IntPtr hwnd = new IntPtr(windowHandle);
        uint dpi = GetDpiForWindow(hwnd);
        double scale = dpi > 0 ? dpi / 96.0 : 1.0;
        Point point = new Point
        {
            X = (int)Math.Round(clientX * scale),
            Y = (int)Math.Round(clientY * scale),
        };
        if (!ClientToScreen(hwnd, ref point))
            throw new InvalidOperationException("Could not convert client coordinates");
        long packedPoint = ((long)(point.Y & 0xffff) << 16) | (uint)(point.X & 0xffff);
        return SendMessage(hwnd, 0x0084, IntPtr.Zero, new IntPtr(packedPoint)).ToInt32();
    }
}
'@

[AtmNativeHitTest]::Probe($WindowHandle, $ClientX, $ClientY)
