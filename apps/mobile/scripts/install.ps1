# 把 APK 装到指定手机并启动。
#
#   pwsh -File apps/mobile/scripts/install.ps1 -Serial a11a603c                 # 最新的 release
#   pwsh -File apps/mobile/scripts/install.ps1 -Serial a11a603c -Variant debug-demo
#   pwsh -File apps/mobile/scripts/install.ps1 -Serial a11a603c -Apk path\to.apk
#
# 只做 `install -r`（覆盖安装，保留数据），从不卸载：debug 与 release 签名不同不能互相覆盖，
# 需要切换时由人决定是否卸载——卸载会清掉配对与缓存。
[CmdletBinding()]
param(
    [string]$Serial = $env:ANDROID_SERIAL,
    [ValidateSet('release', 'debug', 'debug-demo')][string]$Variant = 'release',
    [string]$Apk
)
. (Join-Path $PSScriptRoot 'environment.ps1')

if (-not $Serial) {
    $devices = @(adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\tdevice$' } | ForEach-Object { ($_ -split '\t')[0] })
    if ($devices.Count -ne 1) { throw "请用 -Serial 指定设备（当前连接 $($devices.Count) 台）。" }
    $Serial = $devices[0]
}
if (-not $Apk) { $Apk = Join-Path $DistDir "ATM-mobile-$(Get-MobileVersion)-$Variant.apk" }
if (-not (Test-Path -LiteralPath $Apk)) { throw "找不到 APK：$Apk" }

adb -s $Serial install -r $Apk
Assert-NativeExit 'adb install'
adb -s $Serial shell am start -n 'moe.ayanami.atm/.MainActivity'
Assert-NativeExit 'am start'
Write-Host "已安装并启动：$Apk → $Serial"
