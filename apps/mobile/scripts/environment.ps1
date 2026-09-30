# 手机 App 构建环境（PowerShell 7）。其它脚本开头 dot-source 本文件。
#
# - JDK / Android SDK 不要求全局环境变量：没设时用本机默认位置，只影响当前进程。
# - 所有临时文件落在 apps/mobile/.local/tmp（已被 .gitignore 忽略），Java 与 Gradle 子进程也一样，
#   不往 %TEMP% 根下堆东西。
# - 发布密钥库与产物放在「主仓库」的 .local/ 下：用 git 公共目录定位主仓库根，
#   在 git worktree 里构建也落到同一处，不会每个工作树各生成一把密钥。
$ErrorActionPreference = 'Stop'
$MobileRoot = Split-Path -Parent $PSScriptRoot
$WorktreeRoot = Split-Path -Parent (Split-Path -Parent $MobileRoot)

$commonDir = & git -C $MobileRoot rev-parse --path-format=absolute --git-common-dir 2>$null
if ($LASTEXITCODE -ne 0 -or -not $commonDir) { throw '找不到 git 仓库：请在 ATM 仓库（或它的 worktree）里运行。' }
$MainRepoRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath($commonDir.Trim()))

$env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'D:\program\Android Studio\jbr' }
$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
if (-not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { throw '找不到 JDK 21，请设置 JAVA_HOME。' }
if (-not (Test-Path -LiteralPath (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'))) { throw '找不到 Android SDK，请设置 ANDROID_HOME。' }
$env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$(Join-Path $env:ANDROID_HOME 'platform-tools');$env:PATH"

$MobileTemp = Join-Path $MobileRoot '.local\tmp'
New-Item -ItemType Directory -Force -Path $MobileTemp | Out-Null
$env:TEMP = $MobileTemp
$env:TMP = $MobileTemp
$env:JAVA_TOOL_OPTIONS = "-Djava.io.tmpdir=`"$MobileTemp`""

if (-not $env:ATM_ANDROID_KEYSTORE_PROPS) {
    $env:ATM_ANDROID_KEYSTORE_PROPS = Join-Path $MainRepoRoot '.local\android\keystore.properties'
}
$DistDir = Join-Path $MainRepoRoot '.local\dist'

function Assert-NativeExit([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step 失败，退出码 $LASTEXITCODE" }
}

function Get-MobileVersion {
    return (Get-Content -LiteralPath (Join-Path $MobileRoot 'package.json') -Raw | ConvertFrom-Json).version
}

function Get-ApkSigner {
    $tools = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools') -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending
    foreach ($tool in $tools) {
        $candidate = Join-Path $tool.FullName 'apksigner.bat'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw 'Android SDK 中找不到 apksigner。'
}

function Invoke-WebBuild {
    Push-Location $WorktreeRoot
    try {
        pnpm --filter '@ayanami-task/mobile' build
        Assert-NativeExit 'vite build'
    } finally { Pop-Location }
}

function Invoke-CapSync {
    Push-Location $MobileRoot
    try {
        pnpm exec cap sync android
        Assert-NativeExit 'cap sync android'
    } finally { Pop-Location }
}

function Invoke-Gradle([string[]]$Tasks) {
    Push-Location (Join-Path $MobileRoot 'android')
    try {
        & .\gradlew.bat @Tasks --console=plain
        Assert-NativeExit "gradlew $($Tasks -join ' ')"
    } finally { Pop-Location }
}
