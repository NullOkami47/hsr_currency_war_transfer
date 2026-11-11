[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Config,
    [Parameter(Mandatory=$true)][string]$PowerShellPath,
    [switch]$InstallApprovedDailyPause
)
$ErrorActionPreference='Stop'
if (-not $InstallApprovedDailyPause) { throw 'Installation requires approval of the destination, recovery key custody and daily production pause.' }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf) -or -not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) { throw 'Resolved config and PowerShell executable required.' }
$name='HSR encrypted off-VM backup'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Task already exists; inspect it instead of replacing it.' }
$script=Join-Path $PSScriptRoot 'Collect-WorkerBackup.ps1'
foreach($path in @($Config,$PowerShellPath,$script)){if($path.Contains('"')){throw 'Unsupported path quoting'}}
$action=New-ScheduledTaskAction -Execute $PowerShellPath -Argument "-NoProfile -NonInteractive -File `"$script`" -Config `"$Config`" -AuthoriseServicePause"
$trigger=New-ScheduledTaskTrigger -Daily -At '03:00'
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RunOnlyIfNetworkAvailable
$principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Get-ScheduledTask -TaskName $name
