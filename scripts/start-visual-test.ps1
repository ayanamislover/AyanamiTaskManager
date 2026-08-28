$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = Join-Path $workspace "output\playwright"
$data = Join-Path $output "data"
New-Item -ItemType Directory -Force -Path $data | Out-Null

$env:ATM_DATA_DIR = $data
$env:AYANAMI_TASK_TOKEN = "visual-test-token"
$env:AYANAMI_TASK_PORT = "4393"
$node = (Get-Command node).Source
$daemon = Start-Process -FilePath $node `
  -ArgumentList @("node_modules/tsx/dist/cli.mjs", "apps/daemon/src/main.ts") `
  -WorkingDirectory $workspace -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $output "daemon.stdout.log") `
  -RedirectStandardError (Join-Path $output "daemon.stderr.log") -PassThru

$env:VITE_ATM_ENDPOINT = "http://127.0.0.1:4393"
$env:VITE_ATM_TOKEN = "visual-test-token"
$vite = Start-Process -FilePath $node `
  -ArgumentList @("node_modules/vite/bin/vite.js", "--config", "apps/desktop/vite.config.ts", "--host", "127.0.0.1", "--port", "9999", "--strictPort") `
  -WorkingDirectory $workspace -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $output "vite.stdout.log") `
  -RedirectStandardError (Join-Path $output "vite.stderr.log") -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
  try {
    $headers = @{ Authorization = "Bearer visual-test-token" }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4393/api/v1/system/status" -Headers $headers -TimeoutSec 1
    $page = Invoke-WebRequest -Uri "http://127.0.0.1:9999" -TimeoutSec 1
    if ($health.ok -and $page.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {}
  Start-Sleep -Milliseconds 100
}

[pscustomobject]@{ daemonPid = $daemon.Id; vitePid = $vite.Id; ready = $ready } | ConvertTo-Json -Compress
