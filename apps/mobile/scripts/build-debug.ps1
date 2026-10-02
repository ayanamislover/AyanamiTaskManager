# Debug 构建：打开 WebView 远程调试（chrome://inspect / CDP 截图与量尺寸都靠它）。
#
#   pwsh -File apps/mobile/scripts/build-debug.ps1          # 连真实中继
#   pwsh -File apps/mobile/scripts/build-debug.ps1 -Demo    # 打包演示数据层（界面走查、截图用）
#
# 产物：主仓库 .local/dist/ATM-mobile-<version>-debug.apk
[CmdletBinding()]
param([switch]$Demo)
. (Join-Path $PSScriptRoot 'environment.ps1')

$previousDemo = $env:VITE_ATM_DEMO
$env:ATM_MOBILE_WEBVIEW_DEBUG = '1'
if ($Demo) { $env:VITE_ATM_DEMO = '1' } else { Remove-Item Env:VITE_ATM_DEMO -ErrorAction SilentlyContinue }
try {
    Invoke-WebBuild
    Invoke-CapSync
    Invoke-Gradle @('assembleDebug')
    $apk = Join-Path $MobileRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
    & (Get-ApkSigner) verify $apk
    Assert-NativeExit 'apksigner verify'
    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    $suffix = if ($Demo) { 'debug-demo' } else { 'debug' }
    $destination = Join-Path $DistDir "ATM-mobile-$(Get-MobileVersion)-$suffix.apk"
    Copy-Item -LiteralPath $apk -Destination $destination -Force
    Write-Host "Debug APK: $destination"
} finally {
    Remove-Item Env:ATM_MOBILE_WEBVIEW_DEBUG -ErrorAction SilentlyContinue
    if ($null -ne $previousDemo) { $env:VITE_ATM_DEMO = $previousDemo } else { Remove-Item Env:VITE_ATM_DEMO -ErrorAction SilentlyContinue }
}
