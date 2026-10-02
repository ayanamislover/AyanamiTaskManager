# 生成手机 App 的发布签名密钥库（只需一次）。
#
#   pwsh -File apps/mobile/scripts/keygen.ps1
#
# 默认写到主仓库 .local/android/：atm-release.jks + keystore.properties（ATM_ANDROID_KEYSTORE_PROPS 可改位置）。
# RSA 4096、有效期 10000 天、alias atm。两个口令各 32 位随机字符，只写进 keystore.properties，
# 经环境变量交给 keytool，不出现在命令行、日志或屏幕上。目录与文件 ACL 只留当前用户。
# 已有密钥库时什么也不做；两者缺一时拒绝继续，提示从备份恢复——换了密钥就无法覆盖安装旧版本。
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'environment.ps1')

function Set-OwnerOnly([string]$Path, [bool]$Directory = $false) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = if ($Directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    if ($Directory) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
    }
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# 主仓库根 .gitignore 不含 .local/android：在密钥目录里放一个忽略一切的 .gitignore，
# 防止 git add . 把密钥库和口令带进提交。已有密钥库时也补上。
function Set-SelfIgnore([string]$Directory) {
    $ignorePath = Join-Path $Directory '.gitignore'
    if (-not (Test-Path -LiteralPath $ignorePath)) {
        [System.IO.File]::WriteAllText($ignorePath, "# 发布签名密钥：永不提交`n*`n", [System.Text.UTF8Encoding]::new($false))
    }
}

function New-RandomPassword {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    return -join (1..32 | ForEach-Object { $alphabet[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($alphabet.Length)] })
}

$propsPath = [System.IO.Path]::GetFullPath($env:ATM_ANDROID_KEYSTORE_PROPS)
$keyDirectory = Split-Path -Parent $propsPath
$storePath = Join-Path $keyDirectory 'atm-release.jks'
if (Test-Path -LiteralPath $storePath) {
    if (-not (Test-Path -LiteralPath $propsPath)) { throw '密钥库已存在但 keystore.properties 缺失，请从备份恢复；不会重建密钥。' }
    Set-SelfIgnore $keyDirectory
    Write-Host "发布密钥库已存在，保留原密钥：$storePath"
    return
}
if (Test-Path -LiteralPath $propsPath) { throw 'keystore.properties 已存在但密钥库缺失，请先检查备份；不会覆盖。' }

New-Item -ItemType Directory -Force -Path $keyDirectory | Out-Null
Set-OwnerOnly $keyDirectory $true
Set-SelfIgnore $keyDirectory
try {
    $env:ATM_KEY_STORE_PASS = New-RandomPassword
    $env:ATM_KEY_ENTRY_PASS = New-RandomPassword
    & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -noprompt -storetype JKS -keystore $storePath `
        -alias atm -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=ATM Mobile, O=Ayanami, C=CN' `
        -storepass:env ATM_KEY_STORE_PASS -keypass:env ATM_KEY_ENTRY_PASS
    Assert-NativeExit 'keytool'
    $props = "storeFile=$($storePath.Replace('\', '/'))`nstorePassword=$env:ATM_KEY_STORE_PASS`nkeyAlias=atm`nkeyPassword=$env:ATM_KEY_ENTRY_PASS`n"
    [System.IO.File]::WriteAllText($propsPath, $props, [System.Text.UTF8Encoding]::new($false))
    Set-OwnerOnly $storePath
    Set-OwnerOnly $propsPath
    Write-Host "发布密钥库已建立：$storePath"
    Write-Host '请把这个目录另行安全备份；密钥与口令不会输出。'
} finally {
    Remove-Item Env:ATM_KEY_STORE_PASS, Env:ATM_KEY_ENTRY_PASS -ErrorAction SilentlyContinue
    $props = $null
}
