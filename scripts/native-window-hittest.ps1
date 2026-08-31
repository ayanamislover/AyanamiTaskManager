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
    private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    public static int Probe(long windowHandle, double clientX, double clientY)
    {
        IntPtr hwnd = new IntPtr(windowHandle);
        // Playwright boundingBox() and ClientToScreen() both use the caller's logical
        // client coordinate space. Multiplying by the target window DPI converts the
        // point twice on scaled displays and probes the wrong UI element.
        Point point = new Point
        {
            X = (int)Math.Round(clientX),
            Y = (int)Math.Round(clientY),
        };
        if (!ClientToScreen(hwnd, ref point))
            throw new InvalidOperationException("Could not convert client coordinates");
        long packedPoint = ((long)(point.Y & 0xffff) << 16) | (uint)(point.X & 0xffff);
        return SendMessage(hwnd, 0x0084, IntPtr.Zero, new IntPtr(packedPoint)).ToInt32();
    }
}
'@

[AtmNativeHitTest]::Probe($WindowHandle, $ClientX, $ClientY)
