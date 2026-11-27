<#
.SYNOPSIS
  Weekly architectural-drift sweep, run as a local scheduled task on the owner's machine.

.DESCRIPTION
  Replaces .github/workflows/architectural-drift.yml. The audit store behind AUDIT_DB_URL is on
  the home LAN, so no GitHub-hosted runner can reach it, and the self-hosted runner that used to
  run this job (ai-organiser-runner) is retired.

  The job runs in a DEDICATED worktree (default C:\GIT\ai-organiser-drift) and moves that worktree,
  detached, to origin/main every run. It must never run in the main checkout, which is usually on
  some session's feature branch, and drift is measured against main.

  Credentials are never handled here. The task runs on whatever profile the owner's audit-loop
  tooling resolves, through its own loader (the main checkout's .env, then ~/.audit-loop.env): the
  Azure work profile when it is configured (summaries on its GPT deployment, embeddings on its
  embedding deployment), the public routes otherwise. Nothing prints a DSN or a key.

  Steps, in the same order as the old workflow:
    1. fetch + detach the worktree at origin/main; npm ci when package-lock.json changed; hydrate
    2. preflight (scripts/local/arch-drift-preflight.mjs, the tooling's own route oracles): the cloud
       store, a summariser route and an embedding route must all resolve, or the run fails before
       the refresh. A refresh with no provider publishes an index with no summaries; that is a
       failure, never a pass.
    3. arch:refresh:full (best effort, as before)
    4. arch:drift -> exit 0 green, 1 triggered, anything else is an infra error
    5. arch:prune (best effort, as before)
    6. sticky issue: triggered -> open/update; green -> close; error -> open/update a failure issue

  Exit code: 0 for green or triggered (the job did its work), 1 for any infra error. The scheduled
  task's "Last Run Result" therefore reads 0x1 exactly when the sweep did not run to completion.

  Logs: %LOCALAPPDATA%\ai-organiser-arch-drift\  (run-<utc>.log, report-<utc>.md, last-run.json)

.PARAMETER Worktree
  The dedicated drift worktree. Created by register-arch-drift-task.ps1.

.PARAMETER NoIssue
  Skip every GitHub issue write (for a dry run).
#>
[CmdletBinding()]
param(
    [string]$Worktree = 'C:\GIT\ai-organiser-drift',
    [string]$Repo = 'Lbstrydom/ai-organiser',
    [switch]$NoIssue
)

$ErrorActionPreference = 'Stop'
$LogDir = Join-Path $env:LOCALAPPDATA 'ai-organiser-arch-drift'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp  = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$Log    = Join-Path $LogDir "run-$stamp.log"
$Report = Join-Path $LogDir "report-$stamp.md"

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $msg
    Add-Content -LiteralPath $Log -Value $line
    Write-Host $line
}

# Runs a native command, appending its output to the log. Returns the exit code; never throws.
function Invoke-Step([string]$label, [string]$exe, [string[]]$argv) {
    Write-Log "--> $label"
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        & $exe @argv *>> $Log
        $code = $LASTEXITCODE
    } catch {
        Add-Content -LiteralPath $Log -Value "$_"
        $code = 99
    } finally { $ErrorActionPreference = $prev }
    Write-Log "<-- $label exit $code"
    return $code
}

$ISSUE_MARKER = '<!-- audit-loop:architectural-drift -->'
$FAIL_MARKER  = '<!-- audit-loop:architectural-drift-local-failure -->'

function Find-StickyIssue([string]$label, [string]$marker) {
    $json = gh api "repos/$Repo/issues?state=open&labels=$label&per_page=50" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }
    $hit = $json | ConvertFrom-Json | Where-Object { "$($_.body)".StartsWith($marker) } | Select-Object -First 1
    if ($hit) { return $hit.number } else { return $null }
}

function Set-StickyIssue([string]$label, [string]$marker, [string]$title, [string]$body, [string]$comment) {
    $file = Join-Path $LogDir "issue-body-$stamp.md"
    Set-Content -LiteralPath $file -Value $body -Encoding utf8NoBOM
    $n = Find-StickyIssue $label $marker
    if ($n) {
        gh issue edit $n --repo $Repo --body-file $file *>> $Log
        gh issue comment $n --repo $Repo --body $comment *>> $Log
        Write-Log "issue #$n updated"
    } else {
        gh label create $label --color D93F0B --description 'Architectural drift (local task)' --repo $Repo *>> $Log
        gh issue create --repo $Repo --title $title --label $label --body-file $file *>> $Log
        Write-Log 'issue created'
    }
}

function Close-StickyIssue([string]$label, [string]$marker, [string]$comment) {
    $n = Find-StickyIssue $label $marker
    if ($n) {
        gh issue comment $n --repo $Repo --body $comment *>> $Log
        gh issue close $n --repo $Repo *>> $Log
        Write-Log "issue #$n closed"
    }
}

$status = 'error'; $reason = ''; $driftExit = $null; $head = ''
$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$footer = "`n`n---`n_Auto-generated by the local scheduled task ``scripts/local/arch-drift-local.ps1`` on $today (UTC)._"

# One run at a time, across every way this script can be started.
$mutex = New-Object System.Threading.Mutex($false, 'Global\ai-organiser-arch-drift')
if (-not $mutex.WaitOne(0)) { Write-Log 'another run holds the mutex; exiting'; exit 1 }

try {
    if (-not (Test-Path -LiteralPath (Join-Path $Worktree '.git'))) {
        throw "drift worktree missing at $Worktree; run scripts/local/register-arch-drift-task.ps1"
    }
    Set-Location -LiteralPath $Worktree

    if ((Invoke-Step 'git fetch' 'git' @('fetch', '--quiet', 'origin', 'main')) -ne 0) { throw 'git fetch failed' }
    # The worktree is the task's own; any local change in it is debris from a previous run.
    if ((Invoke-Step 'git checkout' 'git' @('checkout', '--quiet', '--force', '--detach', 'origin/main')) -ne 0) { throw 'git checkout failed' }
    $head = (git rev-parse HEAD).Trim()
    Write-Log "HEAD $head"

    $lockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
    $lockStamp = Join-Path $LogDir 'package-lock.sha256'
    $prevHash = if (Test-Path -LiteralPath $lockStamp) { (Get-Content -LiteralPath $lockStamp -Raw).Trim() } else { '' }
    if ($lockHash -ne $prevHash -or -not (Test-Path -LiteralPath 'node_modules')) {
        if ((Invoke-Step 'npm ci' 'npm' @('ci', '--no-audit', '--no-fund')) -ne 0) { throw 'npm ci failed' }
        Set-Content -LiteralPath $lockStamp -Value $lockHash
    }
    if ((Invoke-Step 'hydrate' 'npm' @('run', '-s', 'skills:hydrate')) -ne 0) { throw 'skills:hydrate failed' }
    foreach ($f in 'symbol-index/drift.mjs', 'symbol-index/prune.mjs', 'learning-store.mjs') {
        if (-not (Test-Path -LiteralPath (Join-Path 'scripts/.claude-skills' $f))) { throw "hydrated tooling lacks $f" }
    }

    # Preflight through the tooling's own route oracles. Prints booleans only.
    $pre = node scripts/local/arch-drift-preflight.mjs 2>>$Log
    $preExit = $LASTEXITCODE
    $preLine = "$($pre | Select-Object -Last 1)"
    Write-Log "preflight: $preLine"
    if ($preExit -ne 0) {
        $why = try { (($preLine | ConvertFrom-Json).problems) -join '; ' } catch { $preLine }
        throw "preflight failed: $why"
    }
    # The cloud store must also be reachable, not merely configured.
    $who = node scripts/.claude-skills/cross-skill.mjs whoami 2>>$Log
    $cloud = $false
    try { $cloud = [bool](($who | Select-Object -Last 1 | ConvertFrom-Json).cloud) } catch { }
    if (-not $cloud) { throw 'cloud store did not resolve (AUDIT_DB_URL unset or unreachable). Refusing to report a pass having checked nothing.' }
    Write-Log 'preflight: cloud store reachable (value not shown)'

    [void](Invoke-Step 'arch:refresh:full' 'npm' @('run', 'arch:refresh:full'))
    $driftExit = Invoke-Step 'arch:drift' 'npm' @('run', 'arch:drift', '--', '--out', $Report)
    [void](Invoke-Step 'arch:prune' 'npm' @('run', 'arch:prune'))

    switch ($driftExit) {
        0 { $status = 'green' }
        1 { $status = 'triggered' }
        default { $status = 'error'; $reason = "drift script exited $driftExit (infra error, not a drift signal)" }
    }
} catch {
    $status = 'error'; $reason = "$_"
    Write-Log "ERROR: $reason"
}

try {
    if (-not $NoIssue) {
        if ($status -eq 'triggered' -and (Test-Path -LiteralPath $Report)) {
            $body = (Get-Content -LiteralPath $Report -Raw) + $footer
            Set-StickyIssue 'architectural-drift' $ISSUE_MARKER "architectural-drift: trigger fired ($today)" $body "Re-triggered on $today (local task, main at $head)."
        } elseif ($status -eq 'green') {
            Close-StickyIssue 'architectural-drift' $ISSUE_MARKER "Drift returned to green on $today. Auto-closing; reopen if a regression is observed."
        }
        if ($status -eq 'error') {
            $body = "$FAIL_MARKER`nThe weekly architectural-drift task failed on this machine and did not complete the sweep.`n`nReason: $reason`n`nLog: ``$Log`` on the owner's machine.$footer"
            Set-StickyIssue 'architectural-drift-local-failure' $FAIL_MARKER "architectural-drift: local task failed ($today)" $body "Failed again on $today. Reason: $reason"
        } else {
            Close-StickyIssue 'architectural-drift-local-failure' $FAIL_MARKER "The local task completed on $today (status $status). Closing."
        }
    }
} catch {
    Write-Log "WARN: issue update failed: $_"
} finally {
    [pscustomobject]@{
        finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
        status = $status; driftExit = $driftExit; head = $head; reason = $reason; log = $Log
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $LogDir 'last-run.json')
    Write-Log "DONE status=$status"
    $mutex.ReleaseMutex(); $mutex.Dispose()
}

if ($status -eq 'error') { exit 1 } else { exit 0 }
