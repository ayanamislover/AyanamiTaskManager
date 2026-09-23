param([ValidateSet('stdio','cli','legacy')][string]$Mode='stdio')
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AtmIndependentJobProbe {
 [StructLayout(LayoutKind.Sequential)] public struct Basic { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
 [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int info,ref Extended limits,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$job=[AtmIndependentJobProbe]::CreateJobObject([IntPtr]::Zero,$null)
if($job -eq [IntPtr]::Zero){throw 'CreateJob failed'}
$limits=New-Object AtmIndependentJobProbe+Extended
$basic=New-Object AtmIndependentJobProbe+Basic
$basic.flags=0x2000
$limits.basic=$basic
if(-not [AtmIndependentJobProbe]::SetInformationJobObject($job,9,[ref]$limits,[Runtime.InteropServices.Marshal]::SizeOf($limits))){[void][AtmIndependentJobProbe]::CloseHandle($job);throw 'Set job limits failed'}
$nodeInfo=New-Object Diagnostics.ProcessStartInfo
$nodeInfo.FileName=(Get-Command node.exe).Source
$nodeInfo.Arguments='"'+(Join-Path (Get-Location).Path 'scripts/independent-wake-smoke-parent.mjs')+'"'
$nodeInfo.WorkingDirectory=(Get-Location).Path
$nodeInfo.UseShellExecute=$false
$nodeInfo.CreateNoWindow=$true
$nodeInfo.RedirectStandardInput=$true
$nodeInfo.RedirectStandardOutput=$true
$nodeInfo.EnvironmentVariables['ATM_WAKE_PROBE_MODE']=$Mode
$parent=[Diagnostics.Process]::Start($nodeInfo)
$result=$null
try {
 if(-not [AtmIndependentJobProbe]::AssignProcessToJobObject($job,$parent.Handle)){throw 'Assign failed; no breakaway attempted'}
 $parent.StandardInput.WriteLine('go')
 $lineTask=$parent.StandardOutput.ReadLineAsync()
 if(-not $lineTask.Wait(40000)){throw 'Probe timeout'}
 $result=$lineTask.Result | ConvertFrom-Json
 if(-not $result.ready){throw ('Isolated wake failed: '+$result.error)}
 $probeDesktop=Get-Process -Id $result.pid
 $inOwnedJob=$false
 if(-not [AtmIndependentJobProbe]::IsProcessInJob($probeDesktop.Handle,$job,[ref]$inOwnedJob)){throw 'Job query failed'}
 # Kill the entire simulated Agent host, including its stdio bridge.
 [void][AtmIndependentJobProbe]::CloseHandle($job)
 $job=[IntPtr]::Zero
 if(-not $parent.WaitForExit(5000)){throw 'Host did not terminate'}
 $endedWithHost=$probeDesktop.WaitForExit(1500)
 if($inOwnedJob -or $endedWithHost){throw 'ATM still tied to host Job'}
 $runtime=Get-Content -LiteralPath (Join-Path $result.data 'runtime/daemon.json') -Raw | ConvertFrom-Json
 $status=Invoke-RestMethod -Uri ($runtime.endpoint+'/api/v1/system/status') -Headers @{Authorization=('Bearer '+$runtime.token)} -TimeoutSec 5
 if(-not $status.version){throw 'Runtime unhealthy after host termination'}
 $evidence=[ordered]@{mode=$Mode;pid=[int]$result.pid;inHostJob=$inOwnedJob;survivedHostClose=(-not $endedWithHost);healthy=$true;version=[string]$status.version;data=[string]$result.data}
 $evidence | ConvertTo-Json -Depth 2
} finally {
 if($job -ne [IntPtr]::Zero){[void][AtmIndependentJobProbe]::CloseHandle($job)}
 if(-not $parent.HasExited){$parent.Kill()}
 $parent.Dispose()
 # Only the unique task associated with this test's data directory is removed.
 if($result -and $result.taskPrefix){
  $svc=New-Object -ComObject 'Schedule.Service';$svc.Connect();$folder=$svc.GetFolder('\')
  $name=$result.taskPrefix+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $task=$folder.GetTask($name);$task.Stop(0);$folder.DeleteTask($name,0)
 }
}
