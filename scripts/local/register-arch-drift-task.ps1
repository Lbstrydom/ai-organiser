<#
.SYNOPSIS
  Creates the dedicated drift worktree and registers (or updates) the weekly scheduled task that
  runs scripts/local/arch-drift-local.ps1.

.DESCRIPTION
  Run once, from the main checkout, after the script is on origin/main (the task runs the copy in
  the drift worktree, which the script itself moves to origin/main every run).

  The task runs as the current user, only while that user is logged on, so no password is stored.
  A run missed while the machine was off starts at the next opportunity (StartWhenAvailable).
  Schedule: Mondays 10:50 local time, the slot the GitHub workflow used (09:50 UTC).

    pwsh -File scripts/local/register-arch-drift-task.ps1            # register / update
    pwsh -File scripts/local/register-arch-drift-task.ps1 -RunNow    # and start one run now
    pwsh -File scripts/local/register-arch-drift-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [string]$Worktree = 'C:\GIT\ai-organiser-drift',
    [string]$TaskName = 'ai-organiser-arch-drift',
    [switch]$RunNow,
    [switch]$Unregister
)
$ErrorActionPreference = 'Stop'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered $TaskName. The worktree at $Worktree is left in place (git worktree remove to drop it)."
    exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $Worktree '.git'))) {
    git fetch --quiet origin main
    git worktree add --detach $Worktree origin/main
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed for $Worktree" }
}
$script = Join-Path $Worktree 'scripts\local\arch-drift-local.ps1'
if (-not (Test-Path -LiteralPath $script)) {
    throw "$script not found: the drift worktree must be at an origin/main that contains it."
}

$pwsh = (Get-Command pwsh).Source
$action = New-ScheduledTaskAction -Execute $pwsh `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$script`" -Worktree `"$Worktree`"" `
    -WorkingDirectory $Worktree
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '10:50'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'ai-organiser weekly architectural drift sweep (scripts/local/arch-drift-local.ps1)' -Force | Out-Null
Write-Host "Registered $TaskName (Mondays 10:50, $env:USERNAME, only when logged on)."

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started. Logs: $(Join-Path $env:LOCALAPPDATA 'ai-organiser-arch-drift')"
}
