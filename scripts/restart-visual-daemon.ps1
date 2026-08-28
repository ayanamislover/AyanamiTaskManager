$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = Join-Path $workspace "output\playwright"
$data = Join-Path $output "data"
$runtimePath = Join-Path $data "runtime\daemon.json"
if (Test-Path -LiteralPath $runtimePath) {
  $runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
  if ($runtime.pid -is [int] -or $runtime.pid -is [long]) {
    Stop-Process -Id $runtime.pid -ErrorAction SilentlyContinue
  }
}
$env:ATM_DATA_DIR = $data
$env:AYANAMI_TASK_TOKEN = "visual-test-token"
$env:AYANAMI_TASK_PORT = "4393"
$daemon = Start-Process -FilePath (Get-Command node).Source `
  -ArgumentList @("node_modules/tsx/dist/cli.mjs", "apps/daemon/src/main.ts") `
  -WorkingDirectory $workspace -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $output "daemon.stdout.log") `
  -RedirectStandardError (Join-Path $output "daemon.stderr.log") -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4393/api/v1/system/status" -Headers @{ Authorization = "Bearer visual-test-token" } -TimeoutSec 1
    if ($health.ok) { $ready = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 100
}
[pscustomobject]@{ daemonPid = $daemon.Id; ready = $ready } | ConvertTo-Json -Compress
