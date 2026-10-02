# 发布构建：vite build → cap sync → assembleRelease → apksigner verify → 读 APK 内容做断言 → 复制到主仓库 .local/dist。
#
#   pwsh -File apps/mobile/scripts/keygen.ps1         # 第一次
#   pwsh -File apps/mobile/scripts/build-release.ps1
#
# 默认先 `pnpm install --frozen-lockfile`（依赖与锁文件一致才可重复）；已经装好时可加 -SkipInstall。
# 发布构建清掉 WebView 调试开关与演示数据开关，结束后恢复调用者的环境变量。
[CmdletBinding()]
param([switch]$SkipInstall)
. (Join-Path $PSScriptRoot 'environment.ps1')

$saved = @{ ATM_MOBILE_WEBVIEW_DEBUG = $env:ATM_MOBILE_WEBVIEW_DEBUG; VITE_ATM_DEMO = $env:VITE_ATM_DEMO }
Remove-Item Env:ATM_MOBILE_WEBVIEW_DEBUG, Env:VITE_ATM_DEMO -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $env:ATM_ANDROID_KEYSTORE_PROPS)) {
    throw "缺少发布签名配置：$($env:ATM_ANDROID_KEYSTORE_PROPS)。先运行 apps/mobile/scripts/keygen.ps1。"
}
try {
    if (-not $SkipInstall) {
        Push-Location $WorktreeRoot
        try { pnpm install --frozen-lockfile; Assert-NativeExit 'pnpm install' } finally { Pop-Location }
    }
    Invoke-WebBuild
    Invoke-CapSync
    Invoke-Gradle @('assembleRelease')
    $apk = Join-Path $MobileRoot 'android\app\build\outputs\apk\release\app-release.apk'
    & (Get-ApkSigner) verify --verbose --print-certs $apk
    Assert-NativeExit 'apksigner verify'

    # 断言读的是 APK 里实际打进去的东西，不是源码或上一次 sync 的结果。
    $inspect = Join-Path $MobileTemp 'release-inspect'
    if (Test-Path -LiteralPath $inspect) { Remove-Item -LiteralPath $inspect -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $inspect | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($apk)
    try {
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -eq 'assets/capacitor.config.json' -or $entry.FullName -like 'assets/public/*') {
                $target = Join-Path $inspect ($entry.FullName -replace '/', '\')
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
            }
        }
    } finally { $archive.Dispose() }
    node (Join-Path $PSScriptRoot 'assert-release.mjs') $inspect
    Assert-NativeExit 'APK 内容断言'
    Remove-Item -LiteralPath $inspect -Recurse -Force

    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    $destination = Join-Path $DistDir "ATM-mobile-$(Get-MobileVersion)-release.apk"
    Copy-Item -LiteralPath $apk -Destination $destination -Force
    Write-Host "APK: $destination"
    Write-Host "SHA256: $((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant())"
    Write-Host "Bytes: $((Get-Item -LiteralPath $destination).Length)"
} finally {
    foreach ($name in $saved.Keys) {
        if ($null -ne $saved[$name]) { Set-Item -Path "Env:$name" -Value $saved[$name] }
    }
}
