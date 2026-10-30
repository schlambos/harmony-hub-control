<#
.SYNOPSIS
  Install or upgrade Harmony Hub Control on a rooted Harmony Hub over SSH.
.DESCRIPTION
  Default mode is upgrade and preserves existing configuration.
  -CleanInstall is an explicit clean install that regenerates configuration.
  -PreflightOnly performs volatile staging only under private
  /var/volatile/codex-install-*: it verifies nonsensitive MD5 hashes,
  compares them with the hub's current files, checks RAM for rollback
  copies, and prints inventory plus a terminal verdict (ALLOWED or
  BLOCKED_*). It performs no persistent writes, pruning, handoff, installs,
  restarts, or other service actions.

  Normal install stages every candidate in that private 0700 volatile tree
  and verifies BusyBox md5sum before any persistent mutation. The hub's
  BusyBox has no mktemp, stat, df, or sync, so changed files install as a
  two-phase commit: each is first written and verified beside its
  destination as <dest>.codex-new (if flash fills up, every copy is removed
  and nothing live changed), then renamed into place, codex_webui last.
  Unchanged files are left alone. Originals are copied into RAM first so any
  later failure restores them with their observed modes.
.PARAMETER PreflightOnly
  Volatile preflight only: stage/verify/compare/report under
  /var/volatile/codex-install-*. No persistent writes, pruning, handoff,
  installs, restarts, or other service actions.
.PARAMETER CleanInstall
  Explicit clean install: regenerate configuration candidates. Omit for the
  default upgrade, which preserves existing configuration unless a candidate
  explicitly replaces it.
.PARAMETER MqttPassword
  MQTT password (never printed in preflight or logs).
#>
param(
    [Alias("Host")]
    [string]$HubHost,
    [string]$KeyPath,
    [int]$Port = 22,
    [string]$SshUser = "root",
    [string]$HubId,
    [string]$MqttBroker = "",
    [int]$MqttPort = 1883,
    [string]$MqttUser = "",
    [string]$MqttPassword = "",
    [string]$MqttBaseTopic = "harmony/hub",
    [string]$MqttDiscoveryPrefix = "homeassistant",
    [string]$MqttClientId = "harmony-local-mqtt",
    [switch]$MqttDisabled,
    [switch]$SkipCloudSuppression,
    [switch]$NoApplyCloudRestart,
    [switch]$NoPrompt,
    # -PreflightOnly: volatile stage/verify/compare/report only under /var/volatile/codex-install-*; no persistent mutation or service actions
    [switch]$PreflightOnly,
    # -CleanInstall: explicit clean install regenerating configuration; default without this switch is upgrade preserving existing configuration
    [switch]$CleanInstall
)

$ErrorActionPreference = "Stop"

$StagePrefix = "/var/volatile/codex-install-"
$HandoffRoot = "/data/codex-backups"
$HandoffBudgetBytes = 256 * 1024
$HandoffKeep = 3
$WebuiDest = "/data/codex/bin/codex_webui"
$NewSuffix = ".codex-new"
$RestoreSuffix = ".codex-rb"
# RAM that must stay free after staging and rollback copies (tmpfs is RAM).
$RamMarginBytes = 4 * 1048576

# Phase 1 could not write a new copy; every copy was removed, nothing live changed.
class CapacityAbort : System.Exception { CapacityAbort([string]$m) : base($m) {} }
# Failure after persistent changes began; requires rollback.
class InstallFailure : System.Exception { InstallFailure([string]$m) : base($m) {} }

$HandoffRequiredPaths = @(
    "/etc/init.d/rcS.local",
    "/opt/luaworks/tasks/connectserver/netservicestarter.lua",
    "/usr/sbin/dropbear",
    "/usr/sbin/dropbearkey",
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    "/data/codex/offline_egress_guard.sh",
    "/data/codexmqtt/config.json",
    "/pkg/codexactivity/codexactivity.lua",
    "/pkg/codexactivity/manifest.json"
)

# Artifacts an upgrade must never replace unless explicitly supplied.
$UpgradeProtectedPaths = @(
    "/data/codex/hub_id",
    "/data/codex/cloud_blocker.conf",
    "/data/codexmqtt/config.json",
    "/data/codex/resource-backups",
    "/data/codex-backups",
    "/data/codex/update-backups"
)

$VerdictAllowed = "ALLOWED"
$VerdictCapacity = "BLOCKED_CAPACITY"
$VerdictRollbackCapacity = "BLOCKED_ROLLBACK_CAPACITY"
$VerdictConfigUncertain = "BLOCKED_CONFIGURATION_UNCERTAINTY"
$VerdictValidation = "BLOCKED_VALIDATION_FAILURE"

function Step($Text) {
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Info($Text) {
    Write-Host "  $Text"
}

function KV($Text) {
    Write-Host $Text
}

function Prompt-IfMissing([string]$Value, [string]$Label, [switch]$Required) {
    if ($Value) { return $Value }
    if ($NoPrompt) {
        if ($Required) { throw "$Label is required" }
        return ""
    }
    $v = Read-Host $Label
    $v = $v.Trim()
    if ($Required -and -not $v) { throw "$Label is required" }
    return $v
}

function Resolve-DefaultKeyPath() {
    $userHome = $env:USERPROFILE
    $sshDir = Join-Path $userHome ".ssh"
    if (-not (Test-Path -LiteralPath $sshDir)) { return $null }
    $keys = Get-ChildItem -LiteralPath $sshDir -Filter "harmony_owner_*" -File |
        Where-Object { $_.Name -notlike "*.pub" } |
        Sort-Object LastWriteTime -Descending
    if (-not $keys) { return $null }
    return $keys[0].FullName
}

function Test-HubId([string]$Value) {
    return [bool]($Value -match '^[0-9]{4,}$')
}

function Resolve-SavedHubId([string]$HubHost) {
    $userRoot = $env:USERPROFILE
    $candidatePaths = @(
        (Join-Path $userRoot ".harmony-hub\known_hubs.json"),
        (Join-Path $userRoot ".harmony-hub\last_root.json"),
        (Join-Path $userRoot ".harmony-hub\hub_id.txt"),
        (Join-Path $ScriptRoot "harmony_hub_id.txt")
    )
    foreach ($path in $candidatePaths) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $name = Split-Path -Leaf $path
        if ($name -eq "known_hubs.json") {
            try {
                $known = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            } catch { continue }
            $entry = $known.PSObject.Properties[$HubHost]
            if ($entry) {
                $hubId = [string]$entry.Value.hub_id
                if (Test-HubId $hubId) { return @{ HubId = $hubId; Source = $path } }
            }
            continue
        }
        if ($name -eq "last_root.json") {
            try {
                $last = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            } catch { continue }
            if ([string]$last.host -eq $HubHost) {
                $hubId = [string]$last.hub_id
                if (Test-HubId $hubId) { return @{ HubId = $hubId; Source = $path } }
            }
            continue
        }
        try {
            $hubId = (Get-Content -LiteralPath $path -Raw).Trim()
        } catch { continue }
        if (Test-HubId $hubId) { return @{ HubId = $hubId; Source = $path } }
    }
    return $null
}

function Quote-ProcessArg([string]$Arg) {
    if ($null -eq $Arg) { return '""' }
    if ($Arg -match '^[A-Za-z0-9_./:@=,%+-]+$') { return $Arg }
    # Windows CRT / .NET ParseArgumentsIntoList rule: backslashes are literal
    # UNLESS they immediately precede a double quote, where each is doubled.
    # Accumulate backslash runs and emit them doubled only before a quote or
    # the closing quote; otherwise pass them through unchanged.
    $out = '"'
    $pending = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq '\') { $pending++; continue }
        if ($ch -eq '"') {
            $out += ('\' * ($pending * 2)) + '\"'
        } else {
            $out += ('\' * $pending) + $ch
        }
        $pending = 0
    }
    return $out + ('\' * ($pending * 2)) + '"'
}

function Remote-Quote([string]$Value) {
    return "'" + ($Value -replace "'", "'`"`"'`"'") + "'"
}

function Get-SshArgs() {
    $args = @(
        "-p", [string]$Port,
        "-i", $KeyPath,
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "$SshUser@$HubHost"
    )
    return $args
}

function Invoke-RemoteRc([string]$Command, [byte[]]$InputBytes = $null, [int]$TimeoutMs = 90000) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "ssh"
    $allArgs = @((Get-SshArgs)) + @($Command)
    $psi.Arguments = (($allArgs | ForEach-Object { Quote-ProcessArg ([string]$_) }) -join " ")
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    if ($null -ne $InputBytes) {
        $stdin = $proc.StandardInput.BaseStream
        $stdin.Write($InputBytes, 0, $InputBytes.Length)
    }
    $proc.StandardInput.Close()
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutMs)) {
        try { $proc.Kill() } catch {}
        throw "ssh timed out after $TimeoutMs ms running: $Command"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    return @{ Code = $proc.ExitCode; Out = $stdout; Err = $stderr }
}

function Invoke-Remote([string]$Command, [byte[]]$InputBytes = $null, [int]$TimeoutMs = 90000) {
    $r = Invoke-RemoteRc $Command $InputBytes $TimeoutMs
    if ($r.Code -ne 0) {
        throw "ssh failed with exit $($r.Code)`ncommand=$Command`nstdout=$($r.Out)`nstderr=$($r.Err)"
    }
    return $r.Out
}

function Test-TcpPort([string]$TargetHost, [int]$TargetPort, [int]$TimeoutMs = 1200) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($TargetHost, $TargetPort)
        return $task.Wait($TimeoutMs) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-TcpPort([string]$TargetHost, [int]$TargetPort, [int]$Seconds, [string]$Label) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-TcpPort $TargetHost $TargetPort) {
            Info "$Label is reachable on port $TargetPort"
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "$Label did not become reachable on port $TargetPort within $Seconds seconds"
}

function Get-LocalMd5([string]$Path) {
    return (Get-FileHash -Algorithm MD5 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-BinManifestNames() {
    # Canonical install list: payload/bin/MANIFEST.txt (same source as tools/payload_bin_inventory.mjs).
    $manifestPath = Join-Path $Payload "bin/MANIFEST.txt"
    $names = @()
    Get-Content -LiteralPath $manifestPath | ForEach-Object {
        if ($_ -match '^([0-9a-fA-F]{32})\s+(\S+)\s*$') { $names += $Matches[2] }
    }
    if ($names.Count -eq 0) { throw "no binaries listed in $manifestPath" }
    foreach ($name in $names) {
        $local = Join-Path $Payload "bin/$name"
        if (-not (Test-Path -LiteralPath $local)) { throw "MANIFEST lists $name but $local is missing" }
    }
    return $names
}

function Build-MqttConfig() {
    $enabled = (-not $MqttDisabled) -and [bool]$MqttBroker
    $cfg = [ordered]@{
        enabled = $enabled
        name = "Harmony Hub"
        clientId = $MqttClientId
        baseTopic = $MqttBaseTopic.Trim('/')
        discoveryPrefix = $MqttDiscoveryPrefix.Trim('/')
        haDiscovery = $true
        pollSeconds = 10
        keepAlive = 60
        broker = [ordered]@{
            host = [string]$MqttBroker
            port = [int]$MqttPort
            username = [string]$MqttUser
            password = [string]$MqttPassword
        }
    }
    return ($cfg | ConvertTo-Json -Compress -Depth 8) + "`n"
}

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Payload = Join-Path $ScriptRoot "payload"

# ------------------------------------------------------------- shared state
$Stage = ""
$Candidates = [System.Collections.ArrayList]::new()
$Probe = @{}
$HandoffEstimate = 0
$ForwardTotal = 0
$RollbackTotal = 0
$StagedTotal = 0
$RamFreeBytes = 0
$RamRequiredBytes = 0
$Verdict = $VerdictValidation
$VerdictReasons = [System.Collections.ArrayList]::new()
$Generations = @{ handoff = 0; resource = 0; settings = 0; update = 0 }
$HandoffDirs = [System.Collections.ArrayList]::new()
$Changed = [System.Collections.ArrayList]::new()
$NewCopies = [System.Collections.ArrayList]::new()
$ResolvedHubId = ""
$FirstInstall = $false
$PreserveStage = $false
$MqttExplicitSupplied = ($PSBoundParameters.ContainsKey("MqttBroker") -or
    $PSBoundParameters.ContainsKey("MqttPort") -or
    $PSBoundParameters.ContainsKey("MqttUser") -or
    $PSBoundParameters.ContainsKey("MqttPassword") -or
    $PSBoundParameters.ContainsKey("MqttBaseTopic") -or
    $PSBoundParameters.ContainsKey("MqttDiscoveryPrefix") -or
    $PSBoundParameters.ContainsKey("MqttClientId") -or
    $PSBoundParameters.ContainsKey("MqttDisabled"))

# ------------------------------------------------------------- candidates

function New-Candidate([string]$Dest, [string]$Mode, [string]$Kind,
    [string]$Local = $null, [string]$Text = $null,
    [switch]$Sensitive, [string]$Condition = "always") {
    return [PSCustomObject]@{
        Dest = $Dest
        Mode = $Mode
        Kind = $Kind
        Local = $Local
        Text = $Text
        Sensitive = [bool]$Sensitive
        Condition = $Condition
        Bytes = 0
        Md5 = ""
        Action = "replace"
        StagedName = ""
    }
}

function Get-CandidateData($Cand) {
    if ($Cand.Local) { return [IO.File]::ReadAllBytes($Cand.Local) }
    return [Text.Encoding]::UTF8.GetBytes([string]$Cand.Text)
}

function Add-Candidate($Cand) {
    $data = Get-CandidateData $Cand
    $Cand.Bytes = $data.Length
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $Cand.Md5 = [BitConverter]::ToString($md5.ComputeHash($data)).Replace("-", "").ToLowerInvariant()
    $Candidates.Add($Cand) | Out-Null
}

function Test-MqttExplicit() {
    return $script:MqttExplicitSupplied
}

function Build-Inventory() {
    $binNames = Get-BinManifestNames
    foreach ($name in $binNames) {
        if ($name -eq "codex_webui") { continue }  # installed last
        Add-Candidate (New-Candidate "/data/codex/bin/$name" "755" "binary" -Local (Join-Path $Payload "bin/$name"))
    }
    Add-Candidate (New-Candidate "/usr/sbin/dropbear" "755" "binary" -Local (Join-Path $Payload "scripts/dropbear"))
    Add-Candidate (New-Candidate "/usr/sbin/dropbearkey" "755" "binary" -Local (Join-Path $Payload "scripts/dropbearkey"))

    Add-Candidate (New-Candidate "/data/codex/init.sh" "755" "runtime" -Local (Join-Path $Payload "scripts/init.sh"))
    Add-Candidate (New-Candidate "/data/codex/offline_egress_guard.sh" "755" "runtime" -Local (Join-Path $Payload "scripts/offline_egress_guard.sh"))
    Add-Candidate (New-Candidate "/data/codex/recovery_ap.sh" "755" "runtime" -Local (Join-Path $Payload "scripts/recovery_ap.sh"))
    Add-Candidate (New-Candidate "/etc/init.d/rcS.local" "755" "runtime" -Local (Join-Path $Payload "scripts/rcS.local"))
    if (-not $SkipCloudSuppression) {
        Add-Candidate (New-Candidate "/opt/luaworks/tasks/connectserver/netservicestarter.lua" "644" "runtime" -Local (Join-Path $Payload "scripts/netservicestarter.lua"))
    }
    Add-Candidate (New-Candidate "/pkg/codexactivity/codexactivity.lua" "644" "plugin" -Local (Join-Path $Payload "activity/codexactivity.lua"))
    Add-Candidate (New-Candidate "/pkg/codexmqtt/codexmqtt.lua" "644" "plugin" -Local (Join-Path $Payload "mqtt/codexmqtt.lua"))

    # Configuration: generated only in clean mode or when explicitly supplied.
    if ($CleanInstall -or $HubId) {
        Add-Candidate (New-Candidate "/data/codex/hub_id" "644" "config" -Text "$ResolvedHubId`n")
    }
    if ($CleanInstall) {
        $blocker = "1`n"
        if ($SkipCloudSuppression) { $blocker = "0`n" }
        Add-Candidate (New-Candidate "/data/codex/cloud_blocker.conf" "644" "config" -Text $blocker)
    } elseif (-not $SkipCloudSuppression) {
        # Without the file, codex_webui and netservicestarter.lua treat the
        # cloud as blocked but the egress guard and the activity writer
        # don't: create it, and keep whatever value is already there.
        Add-Candidate (New-Candidate "/data/codex/cloud_blocker.conf" "644" "config" -Text "1`n" -Condition "if-missing")
    }
    Add-Candidate (New-Candidate "/etc/tdeenable" "644" "config" -Text "1`n" -Condition "if-missing")
    Add-Candidate (New-Candidate "/pkg/codexactivity/manifest.json" "644" "config" -Text ('{"plugin":"codexactivity"}' + "`n") -Condition "if-missing")
    Add-Candidate (New-Candidate "/pkg/codexmqtt/manifest.json" "644" "config" -Text ('{"plugin":"codexmqtt"}' + "`n") -Condition "if-missing")
    if ($CleanInstall -or (Test-MqttExplicit)) {
        Add-Candidate (New-Candidate "/data/codexmqtt/config.json" "600" "config" -Text (Build-MqttConfig) -Sensitive)
    }

    # codex_webui is always the final replacement.
    Add-Candidate (New-Candidate $WebuiDest "755" "binary" -Local (Join-Path $Payload "bin/codex_webui"))
}

# --------------------------------------------------------------- staging

function New-StageSuffix() {
    # Random staging-dir suffix (the hub has no mktemp).
    $bytes = New-Object byte[] 6
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function New-StagingTree() {
    Step "Creating private staging tree"
    $stage = $StagePrefix + (New-StageSuffix)
    if ($stage -cnotmatch '^/var/volatile/codex-install-[0-9a-z]+$') { throw "unsafe staging path: $stage" }
    # mkdir fails if the path already exists, so the tree is ours alone.
    $q = Remote-Quote $stage
    $out = (Invoke-Remote "mkdir $q && chmod 700 $q && echo $q" $null 30000).Trim()
    if ($out -cne $stage) { throw "staging tree creation echoed '$out', expected '$stage'" }
    $script:Stage = $stage
    KV "staging_dir=$stage"
    Info "mode=0700 owner-only volatile staging; deleted before exit unless rollback needs it"
}

function Send-CandidatesToStage() {
    Step "Uploading candidates to staging"
    for ($i = 0; $i -lt $Candidates.Count; $i++) {
        $cand = $Candidates[$i]
        $name = "{0:D2}-{1}" -f $i, ($cand.Dest.Split('/')[-1])
        $cand.StagedName = $name
        $remote = "$Stage/$name"
        $command = "cat > $(Remote-Quote $remote) && chmod 600 $(Remote-Quote $remote)"
        $timeout = [Math]::Max(90000, 45000 + [int]($cand.Bytes / 12) )
        Invoke-Remote $command (Get-CandidateData $cand) $timeout | Out-Null
        $shown = $cand.Md5
        if ($cand.Sensitive) { $shown = "<hidden>" }
        KV "staged index=$i dest=$($cand.Dest) bytes=$($cand.Bytes) md5=$shown"
    }
}

function Test-StagedMd5() {
    Step "Verifying staged candidate MD5 (strict BusyBox format)"
    $md5Re = '^[0-9a-f]{32}  .+$'
    $entries = @{}
    $paths = @()
    foreach ($cand in $Candidates) {
        if ($cand.Sensitive) { continue }
        $entries["$Stage/$($cand.StagedName)"] = $cand.Md5
        $paths += Remote-Quote "$Stage/$($cand.StagedName)"
    }
    $out = Invoke-Remote ("md5sum " + ($paths -join " ")) $null 120000
    $seen = @{}
    foreach ($line in ($out -split "`n")) {
        $line = $line.Trim()
        if (-not $line) { continue }
        if ($line -cnotmatch $md5Re) { throw "unexpected md5sum output line: $line" }
        $parts = $line -split "  ", 2
        $digest = $parts[0]
        $path = $parts[1]
        if (-not $entries.Contains($path)) { throw "md5sum reported unexpected path: $path" }
        if ($digest -cne $entries[$path]) { throw "staged md5 mismatch for ${path}: expected $($entries[$path]) got $digest" }
        $seen[$path] = $true
    }
    foreach ($path in $entries.Keys) {
        if (-not $seen.Contains($path)) { throw "md5sum output missing entry: $path" }
    }
    # Sensitive candidates: verify but never print the digest. Require
    # exactly one matched line per expected path; a short response fails.
    foreach ($cand in $Candidates) {
        if (-not $cand.Sensitive) { continue }
        $remote = "$Stage/$($cand.StagedName)"
        $r = Invoke-RemoteRc ("md5sum " + (Remote-Quote $remote)) $null 60000
        if ($r.Code -ne 0) { throw "staged sensitive candidate failed md5 verification: $($cand.Dest)" }
        $matched = 0
        foreach ($line in ($r.Out -split "`n")) {
            $line = $line.Trim()
            if (-not $line) { continue }
            if ($line -cnotmatch $md5Re) { throw "unexpected md5sum output for $($cand.Dest)" }
            $parts = $line -split "  ", 2
            if ($parts[1] -cne $remote -or $parts[0] -cne $cand.Md5) {
                throw "staged sensitive candidate failed md5 verification: $($cand.Dest)"
            }
            $matched++
        }
        if ($matched -ne 1) { throw "staged sensitive candidate failed md5 verification: $($cand.Dest)" }
    }
    Info "all staged candidates verified"
}

function Get-RemoteMd5([string]$Path) {
    $r = Invoke-RemoteRc ("md5sum " + (Remote-Quote $Path)) $null 90000
    $first = ($r.Out.Trim() -split "`n")[0].Trim()
    if ($r.Code -ne 0 -or $first -cnotmatch '^[0-9a-f]{32}  .+$') { return "" }
    $parts = $first -split "  ", 2
    if ($parts[1] -cne $Path) { return "" }
    return $parts[0]
}

# ------------------------------------------------------------- discovery

function ConvertTo-OctalMode([string]$Perm) {
    # Octal mode from an `ls -l` permission string, e.g. -rwxr-xr-x -> 755.
    if ($Perm -cnotmatch '^-[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$') { throw "bad permissions $Perm" }
    $special = 0
    $digits = ""
    $flags = @(4, 2, 1)
    for ($g = 0; $g -lt 3; $g++) {
        $r = $Perm[1 + 3 * $g]; $w = $Perm[2 + 3 * $g]; $x = $Perm[3 + 3 * $g]
        $value = 0
        if ($r -ceq 'r') { $value += 4 }
        if ($w -ceq 'w') { $value += 2 }
        if ('xst'.Contains([string]$x)) { $value += 1 }
        if ('sStT'.Contains([string]$x)) { $special = $special -bor $flags[$g] }
        $digits += [string]$value
    }
    if ($special) { return "$special$digits" }
    return $digits
}

function Get-FileStatus([string[]]$Paths) {
    # One BusyBox-only probe for many paths: just test, ls -l, and md5sum.
    $quoted = ($Paths | ForEach-Object { Remote-Quote $_ }) -join " "
    $cmd = "for p in $quoted; do " +
        'if [ -L "$p" ]; then echo "file_status type=symlink path=$p"; ' +
        'elif [ -f "$p" ]; then set -- $(ls -l "$p"); m=$(md5sum "$p"); ' +
        'echo "file_status type=regular perm=$1 bytes=$5 md5=${m%% *} path=$p"; ' +
        'elif [ -e "$p" ]; then echo "file_status type=other path=$p"; ' +
        'else echo "file_status type=absent path=$p"; fi; done'
    $r = Invoke-RemoteRc $cmd $null 180000
    if ($r.Code -ne 0) { Stop-WithValidation "file-status probe failed (exit $($r.Code)): $($r.Err.Trim())" }
    # Strict: every requested path exactly once with a known type; regular
    # files need valid permissions, a decimal size, and a 32-hex md5.
    $lineRe = '^file_status type=(\S+)(?: perm=(\S*) bytes=(\S*) md5=(\S*))? path=(.+)$'
    $states = @{}
    foreach ($line in ($r.Out -split "`n")) {
        $line = $line.Trim()
        if (-not $line) { continue }
        if ($line -cnotmatch $lineRe) { Stop-WithValidation "file-status: unexpected probe line: $line" }
        $kind = $Matches[1]; $perm = $Matches[2]; $size = $Matches[3]; $md5 = $Matches[4]; $path = $Matches[5]
        if ($Paths -cnotcontains $path) { Stop-WithValidation "file-status: probe reported unexpected path: $path" }
        if ($states.Contains($path)) { Stop-WithValidation "file-status: probe reported $path twice" }
        if ($kind -cnotin @("absent", "regular", "symlink", "other")) { Stop-WithValidation "file-status for $path reported invalid type $kind" }
        if ($kind -cne "regular") {
            if ($null -ne $perm) { Stop-WithValidation "file-status for ${path}: $kind with file fields: $line" }
            $states[$path] = @{ kind = $kind; size = "0"; mode = ""; md5 = "" }
            continue
        }
        $mode = ""
        try { $mode = ConvertTo-OctalMode $perm } catch { Stop-WithValidation "file-status for $path reported invalid permissions $perm" }
        if ($size -cnotmatch '^\d+$') { Stop-WithValidation "file-status for $path reported invalid size $size" }
        if ($md5 -cnotmatch '^[0-9a-f]{32}$') { Stop-WithValidation "file-status for ${path}: regular file without a computed md5" }
        $states[$path] = @{ kind = "regular"; size = $size; mode = $mode; md5 = $md5 }
    }
    foreach ($path in $Paths) {
        if (-not $states.Contains($path)) { Stop-WithValidation "file-status: probe output missing $path" }
    }
    return $states
}

function Invoke-DestinationProbe() {
    Step "Probing destination state (BusyBox ls -l / md5sum)"
    $dests = @($Candidates | ForEach-Object { $_.Dest })
    foreach ($p in $HandoffRequiredPaths) { if ($dests -notcontains $p) { $dests += $p } }
    $script:Probe = Get-FileStatus $dests
    foreach ($cand in $Candidates) {
        $kind = $Probe[$cand.Dest]["kind"]
        if ($kind -in @("symlink", "other")) {
            Stop-WithValidation "destination $($cand.Dest) is a $kind, not a regular file"
        }
    }
}

function Stop-WithValidation([string]$Reason) {
    $script:Verdict = $VerdictValidation
    $VerdictReasons.Add($Reason) | Out-Null
    throw $Reason
}

function Resolve-HubIdentity() {
    $hubId = $HubId
    $existing = (Invoke-Remote "cat /data/codex/hub_id 2>/dev/null || true" $null 30000).Trim()
    if (-not $existing -and -not $CleanInstall) {
        # A hub without /data/codex/hub_id has no configuration of ours to
        # preserve, so the first install writes it, as -CleanInstall does.
        $script:CleanInstall = $true
        $script:FirstInstall = $true
        Info "first install: the hub has no /data/codex/hub_id yet, so this run writes the configuration (as -CleanInstall)"
    }
    if (-not $hubId) {
        if ($existing) {
            $hubId = $existing
            Info "hub id from existing /data/codex/hub_id: $hubId"
        } else {
            $saved = Resolve-SavedHubId $HubHost
            if ($saved) {
                $hubId = $saved.HubId
                Info "hub id from root-tool handoff: $hubId ($($saved.Source))"
            }
        }
    }
    if (-not (Test-HubId $hubId)) {
        if ($hubId) {
            throw "Invalid Hub ID '$hubId'. Re-run the root tool or pass the numeric Hub ID with -HubId."
        }
        throw "Hub ID is required. Re-run the root tool so it writes the handoff file, or pass -HubId with the numeric value printed as hub_id=..."
    }
    $script:ResolvedHubId = $hubId
    Info "using hub id $hubId"
}

function Set-UpgradeGates() {
    foreach ($cand in $Candidates) {
        $state = $null
        if ($Probe.Contains($cand.Dest)) { $state = $Probe[$cand.Dest] }
        $exists = ($null -ne $state) -and ($state["kind"] -eq "regular")
        if ($cand.Condition -eq "if-missing" -and $exists -and -not $CleanInstall) {
            $cand.Action = "preserve"
        } elseif ($exists -and ($state["md5"] -ceq $cand.Md5) -and ($state["mode"] -ceq $cand.Mode)) {
            $cand.Action = "unchanged"
        } elseif ($exists) {
            $cand.Action = "replace"
        } else {
            $cand.Action = "create"
        }
    }
    # Upgrade mode: hub_id must exist or be explicitly supplied.
    $hubState = $null
    if ($Probe.Contains("/data/codex/hub_id")) { $hubState = $Probe["/data/codex/hub_id"] }
    $hasHubCandidate = [bool]($Candidates | Where-Object { $_.Dest -eq "/data/codex/hub_id" })
    if (-not $CleanInstall -and (($null -eq $hubState) -or ($hubState["kind"] -ne "regular")) -and -not $hasHubCandidate) {
        $script:Verdict = $VerdictConfigUncertain
        $VerdictReasons.Add("upgrade mode: /data/codex/hub_id missing and no explicit -HubId supplied") | Out-Null
    }
}

function Get-ActiveCandidates() {
    return @($Candidates | Where-Object { $_.Action -in @("replace", "create") })
}

function Get-RamStatus() {
    # Usable RAM from /proc/meminfo; staging and rollback copies live in tmpfs.
    # The hub kernel has no MemAvailable, so credit what the kernel reclaims for
    # tmpfs on demand: inactive file cache and reclaimable slab (see install_webui.py).
    $out = Invoke-Remote "cat /proc/meminfo" $null 30000
    if ($out -cnotmatch '(?m)^MemFree:\s+(\d+) kB\s*$') { Stop-WithValidation "could not read MemFree from /proc/meminfo" }
    $kb = [long]$Matches[1]
    foreach ($field in 'Inactive\(file\)', 'SReclaimable') {
        if ($out -cmatch "(?m)^${field}:\s+(\d+) kB\s*$") { $kb += [long]$Matches[1] }
    }
    $script:RamFreeBytes = $kb * 1024
}

function Build-Plans() {
    Step "Planning changed destinations"
    $script:ForwardTotal = 0
    $script:RollbackTotal = 0
    $script:StagedTotal = 0
    foreach ($cand in $Candidates) {
        $script:StagedTotal += $cand.Bytes
        $state = $Probe[$cand.Dest]
        if ($cand.Action -in @("replace", "create")) { $script:ForwardTotal += $cand.Bytes }
        if ($cand.Action -eq "replace") { $script:RollbackTotal += [long]$state["size"] }
        $existsFlag = 0
        if ($state["kind"] -eq "regular") { $existsFlag = 1 }
        KV "destination dest=$($cand.Dest) exists=$existsFlag action=$($cand.Action) bytes=$($cand.Bytes) mode=$($cand.Mode)"
    }
    # Staged candidates already occupy RAM; rollback copies are added next.
    $script:RamRequiredBytes = $RollbackTotal + $RamMarginBytes
}

function Count-BackupGenerations() {
    $cmd = 'for d in /data/codex-backups /data/codex/resource-backups /data/codex/update-backups; do [ -d "$d" ] || continue; for n in "$d"/*; do [ -e "$n" ] && echo "$n"; done; done'
    $out = Invoke-Remote $cmd $null 30000
    foreach ($line in ($out -split "`n")) {
        $path = $line.Trim()
        $name = $path.Split('/')[-1]
        if (-not $name) { continue }
        if ($name -match '^webui-handoff-\d{8}-\d{6}$') {
            $Generations["handoff"]++
            if ($path -ceq "$HandoffRoot/$name") { $HandoffDirs.Add($path) | Out-Null }
        }
        elseif ($name -match '^settings_\d{8}_\d{6}$') { $Generations["settings"]++ }
        elseif ($name -match '^\d{8}_\d{6}$') { $Generations["resource"]++ }
        elseif ($name -match '^\d+$') { $Generations["update"]++ }
    }
}

function Get-HandoffEstimate() {
    $total = 0
    foreach ($path in $HandoffRequiredPaths) {
        if ($Probe.Contains($path) -and $Probe[$path]["kind"] -eq "regular") {
            $total += [long]$Probe[$path]["size"]
        }
    }
    $script:HandoffEstimate = $total
}

function Set-Verdict() {
    if ($Verdict -eq $VerdictConfigUncertain) { return }
    if ($RamFreeBytes -lt $RamRequiredBytes) {
        $script:Verdict = $VerdictRollbackCapacity
        $VerdictReasons.Add("free RAM $RamFreeBytes < rollback copies + margin $RamRequiredBytes") | Out-Null
    } else {
        $script:Verdict = $VerdictAllowed
    }
}

# ---------------------------------------------------------------- report

function Show-PreflightReport() {
    # NOTE(InstallerCliUX): human-facing Step/Info strings in this function are
    # owned by InstallerCliUX; the KV key=value lines are the stable contract.
    Step "Preflight report"
    Info "Status so far uses private volatile staging under /var/volatile/codex-install-* only."
    Info "No persistent hub paths have been written, pruned, handed off, installed, or restarted yet."
    if ($PreflightOnly) {
        Info "Mode: -PreflightOnly — stages, verifies, compares, and prints a terminal verdict; performs no persistent writes and no service actions."
    }
    if ($FirstInstall) {
        Info "Install mode: first install — the hub has no configuration of ours yet, so configuration candidates are written."
    } elseif ($CleanInstall) {
        Info "Install mode: explicit clean install — configuration candidates are regenerated."
    } else {
        Info "Install mode: default upgrade — existing configuration is preserved unless a candidate explicitly replaces it."
    }
    $mode = "upgrade"
    if ($CleanInstall) { $mode = "clean" }
    KV "preflight_mode=$mode"
    KV "candidate_count=$($Candidates.Count)"
    KV "changed_count=$((Get-ActiveCandidates).Count)"
    Info "Candidate destinations and nonsensitive expected MD5 hashes (sensitive values redacted):"
    for ($i = 0; $i -lt $Candidates.Count; $i++) {
        $cand = $Candidates[$i]
        $shown = $cand.Md5
        if ($cand.Sensitive) { $shown = "<hidden>" }
        KV "candidate index=$i dest=$($cand.Dest) bytes=$($cand.Bytes) md5=$shown mode=$($cand.Mode) kind=$($cand.Kind) action=$($cand.Action)"
        Info "candidate[$i] path=$($cand.Dest) expected_md5=$shown bytes=$($cand.Bytes) mode=$($cand.Mode) action=$($cand.Action)"
    }
    if (-not $CleanInstall) {
        KV "protected_upgrade_paths=$($UpgradeProtectedPaths -join ',')"
        Info "Upgrade protects existing configuration at: $($UpgradeProtectedPaths -join ', ')"
    }
    KV "backup_generations handoff=$($Generations['handoff']) resource=$($Generations['resource']) settings=$($Generations['settings']) update=$($Generations['update'])"
    KV "handoff_estimate_bytes=$HandoffEstimate"
    KV "flash_capacity_check=two-phase-commit"
    KV "forward_total_bytes=$ForwardTotal"
    KV "rollback_total_bytes=$RollbackTotal"
    KV "staged_total_bytes=$StagedTotal"
    KV "ram_free_bytes=$RamFreeBytes"
    KV "ram_required_bytes=$RamRequiredBytes"
    Info "Flash free space cannot be measured on this firmware (no df/statvfs): changed files ($ForwardTotal bytes) are written as $NewSuffix copies first, and the install aborts with no live changes if flash fills up."
    Info "RAM: free=$RamFreeBytes required=$RamRequiredBytes (rollback copies $RollbackTotal + margin $RamMarginBytes)"
    foreach ($reason in $VerdictReasons) {
        KV "verdict_reason=$reason"
        Info "verdict_reason: $reason"
    }
    Show-Verdict
}

function Show-Verdict() {
    # NOTE(InstallerCliUX): human-facing verdict prose is owned by
    # InstallerCliUX; the verdict= KV line is the stable contract.
    KV "verdict=$Verdict"
    Info "Terminal verdict: $Verdict"
    if ($Verdict -eq $VerdictAllowed) {
        Info "ALLOWED — validation and RAM headroom are sufficient for the selected mode."
        if ($PreflightOnly) {
            Info "Preflight-only complete: volatile staging will be removed; no persistent changes or service actions were performed."
        } else {
            Info "Persistent install may proceed after this report ($NewSuffix copies, then same-directory renames)."
        }
    } elseif ($Verdict -eq $VerdictCapacity) {
        Info "BLOCKED_CAPACITY — flash filled up while writing the new copies; they were removed and no live file changed."
    } elseif ($Verdict -eq $VerdictRollbackCapacity) {
        Info "BLOCKED_ROLLBACK_CAPACITY — not enough free RAM to hold rollback copies of the files being replaced. No persistent changes."
    } elseif ($Verdict -eq $VerdictConfigUncertain) {
        Info "BLOCKED_CONFIGURATION_UNCERTAINTY — required configuration state is missing or ambiguous for default upgrade; pass -HubId or use -CleanInstall. No persistent changes."
    } else {
        Info "BLOCKED_VALIDATION_FAILURE — staging, path, hash, or probe validation failed; see verdict_reason lines above. No persistent changes."
    }
}

# ---------------------------------------------------------------- mutate

function Add-RollbackCopies() {
    Step "Preparing volatile rollback copies"
    $md5Re = '^[0-9a-f]{32}  .+$'
    # Build rollback records in candidate install order (replaces and creates
    # interleaved) so reverse-order rollback is true reverse install order.
    for ($i = 0; $i -lt $Candidates.Count; $i++) {
        $cand = $Candidates[$i]
        if ($cand.Action -eq "replace") {
            $state = $Probe[$cand.Dest]
            $rb = "$Stage/rb-{0:D2}-{1}" -f $i, ($cand.Dest.Split('/')[-1])
            $cmd = "cp -p $(Remote-Quote $cand.Dest) $(Remote-Quote $rb) && chmod 600 $(Remote-Quote $rb) && md5sum $(Remote-Quote $rb)"
            $out = Invoke-Remote $cmd $null 90000
            $last = ($out.Trim() -split "`n")[-1].Trim()
            if ($last -cnotmatch $md5Re) { throw "rollback copy verification failed for $($cand.Dest)" }
            $digest = ($last -split "  ", 2)[0]
            if ($digest -cne $state["md5"]) { throw "rollback copy verification failed for $($cand.Dest)" }
            $Changed.Add(@{
                Dest = $cand.Dest
                Mode = $state["mode"]
                Md5 = $state["md5"]
                Rb = $rb
                WasAbsent = $false
                Done = $false
            }) | Out-Null
            $shown = $state['md5']
            if ($cand.Sensitive) { $shown = "<hidden>" }
            Info "rollback copy ready dest=$($cand.Dest) mode=$($state['mode']) md5=$shown"
        } elseif ($cand.Action -eq "create") {
            $Changed.Add(@{
                Dest = $cand.Dest
                Mode = $cand.Mode
                Md5 = ""
                Rb = ""
                WasAbsent = $true
                Done = $false
            }) | Out-Null
        }
    }
}

function Invoke-HandoffPrune() {
    # Keep only the newest $HandoffKeep installer handoff generations. Only
    # installer-owned webui-handoff-<stamp> directories directly under
    # $HandoffRoot are ever removed; other backups are never touched.
    Step "Pruning installer handoff backups (keeping newest $HandoffKeep)"
    $sorted = @($HandoffDirs | Sort-Object)
    $count = [Math]::Max(0, $sorted.Count - $HandoffKeep)
    $pattern = '^' + [regex]::Escape($HandoffRoot) + '/webui-handoff-\d{8}-\d{6}$'
    for ($i = 0; $i -lt $count; $i++) {
        $path = $sorted[$i]
        if ($path -cnotmatch $pattern) { throw "refusing to prune unexpected path '$path'" }
        $r = Invoke-RemoteRc ("rm -rf " + (Remote-Quote $path)) $null 60000
        if ($r.Code -ne 0) { Info "warning: could not prune ${path}: $($r.Err.Trim())" } else { KV "pruned=$path" }
    }
    if ($count -eq 0) { Info "nothing to prune" }
}

function New-HandoffBackup() {
    Step "Creating bounded handoff backup"
    # Sizes come from the BusyBox probe; the budget guard runs on the hub.
    $cmd = "S=`$(date -u +%Y%m%d-%H%M%S); B=$HandoffRoot; " +
        'I="$B/.incomplete-webui-handoff-$S"; ' +
        'mkdir -p "$B" || exit 1; mkdir "$I" || exit 1; tot=0; '
    foreach ($path in $HandoffRequiredPaths) {
        if (-not ($Probe.Contains($path) -and $Probe[$path]["kind"] -eq "regular")) { continue }
        $size = [long]$Probe[$path]["size"]
        $cmd += "sz=$size; " +
            "if [ `$((tot + sz)) -le $HandoffBudgetBytes ]; then " +
            "n=`$(echo $(Remote-Quote $path) | sed 's#/#_#g'); " +
            "cp -p $(Remote-Quote $path) `"`$I/`$n`" || { rm -rf `"`$I`"; exit 1; }; " +
            'tot=$((tot + sz)); ' +
            "else echo `"handoff_skipped=$path`"; fi; "
    }
    $cmd += 'mv "$I" "$B/webui-handoff-$S" || { rm -rf "$I"; exit 1; }; ' +
        'echo "handoff=$B/webui-handoff-$S"'
    $out = Invoke-Remote $cmd $null 120000
    $created = $null
    foreach ($line in ($out.Trim() -split "`n")) {
        Info $line
        if ($line.StartsWith("handoff=")) { $created = $line.Substring(8).Trim() }
    }
    if (-not $created) { throw "handoff directory rename did not complete" }
    $HandoffDirs.Add($created) | Out-Null
}

function Remove-NewCopies() {
    # Remove every <dest>.codex-new this run wrote; return those that failed.
    $failed = @()
    foreach ($path in @($NewCopies)) {
        $r = Invoke-RemoteRc ("rm -f " + (Remote-Quote $path)) $null 30000
        if ($r.Code -ne 0) { $failed += $path }
    }
    $NewCopies.Clear()
    return $failed
}

function Write-NewCopies() {
    # Phase 1: write and verify <dest>.codex-new next to every changed dest.
    Step "Phase 1: writing verified $NewSuffix copies (no live file changes)"
    foreach ($cand in (Get-ActiveCandidates)) {
        $new = $cand.Dest + $NewSuffix
        $NewCopies.Add($new) | Out-Null
        $cmd = "cp $(Remote-Quote "$Stage/$($cand.StagedName)") $(Remote-Quote $new) && " +
            "chmod $(Remote-Quote $cand.Mode) $(Remote-Quote $new) && md5sum $(Remote-Quote $new)"
        $r = Invoke-RemoteRc $cmd $null 180000
        $last = ($r.Out.Trim() -split "`n")[-1].Trim()
        $ok = ($r.Code -eq 0) -and ($last -cmatch '^[0-9a-f]{32}  .+$') -and (($last -split "  ", 2)[0] -ceq $cand.Md5)
        if (-not $ok) {
            $left = @(Remove-NewCopies)
            $reason = $r.Err.Trim()
            if (-not $reason) { $reason = "copy verification failed" }
            if ($left.Count -gt 0) {
                throw (New-Object InstallFailure "could not write $new ($reason) and could not remove $($left -join ', ')")
            }
            throw (New-Object CapacityAbort "could not write ${new}: $reason")
        }
        Info "staged dest=$new bytes=$($cand.Bytes)"
    }
}

function Install-Sequence() {
    # Phase 2: rename each verified copy over its destination, codex_webui last.
    Step "Phase 2: renaming new copies into place (codex_webui last)"
    foreach ($cand in (Get-ActiveCandidates)) {
        $new = $cand.Dest + $NewSuffix
        $r = Invoke-RemoteRc ("mv -f " + (Remote-Quote $new) + " " + (Remote-Quote $cand.Dest)) $null 60000
        if ($r.Code -ne 0) { throw "rename failed for $($cand.Dest): $($r.Err.Trim())" }
        $NewCopies.Remove($new)
        foreach ($item in $Changed) { if ($item.Dest -eq $cand.Dest) { $item.Done = $true } }
        Info "installed dest=$($cand.Dest) mode=$($cand.Mode) bytes=$($cand.Bytes)"
    }
}

function Test-Installed() {
    Step "Verifying installed bytes, hashes, and modes"
    $active = Get-ActiveCandidates
    $states = Get-FileStatus @($active | ForEach-Object { $_.Dest })
    foreach ($cand in $active) {
        $state = $states[$cand.Dest]
        if ($state["kind"] -cne "regular") {
            throw "post-install verification failed for $($cand.Dest): kind=$($state['kind'])"
        }
        if ([long]$state["size"] -ne [long]$cand.Bytes) {
            throw "post-install byte mismatch for $($cand.Dest): expected $($cand.Bytes) got $($state['size'])"
        }
        if ($state["md5"] -cne $cand.Md5) {
            throw "post-install checksum mismatch for $($cand.Dest)"
        }
        if ($state["mode"] -cne $cand.Mode) {
            throw "post-install mode mismatch for $($cand.Dest): expected $($cand.Mode) got $($state['mode'])"
        }
    }
    Info "installed candidates verified"
}

function Invoke-Rollback([string]$Trigger) {
    Step "Rolling back changed paths"
    Info "trigger: $Trigger"
    $incomplete = $false
    foreach ($path in @(Remove-NewCopies)) {
        $incomplete = $true
        Info "ROLLBACK FAILED could not remove leftover $path"
    }
    $doneItems = @($Changed | Where-Object { $_.Done })
    $pending = @($doneItems)
    [Array]::Reverse($pending)
    foreach ($item in $pending) {
        $dest = $item.Dest
        if ($item.WasAbsent) {
            $r = Invoke-RemoteRc ("rm -f " + (Remote-Quote $dest)) $null 30000
            if ($r.Code -ne 0) {
                $incomplete = $true
                Info "ROLLBACK FAILED remove new path ${dest}: $($r.Out.Trim())"
                continue
            }
            Info "removed new path $dest (original absence recorded)"
            continue
        }
        # Restore the RAM copy beside the destination with its observed mode,
        # then rename over it.
        $tmp = $dest + $RestoreSuffix
        $cmd = "cp $(Remote-Quote ([string]$item.Rb)) $(Remote-Quote $tmp) && " +
            "chmod $(Remote-Quote ([string]$item.Mode)) $(Remote-Quote $tmp) && " +
            "mv -f $(Remote-Quote $tmp) $(Remote-Quote $dest)"
        $r = Invoke-RemoteRc $cmd $null 180000
        if ($r.Code -ne 0) {
            $incomplete = $true
            Invoke-RemoteRc ("rm -f " + (Remote-Quote $tmp)) $null 30000 | Out-Null
            Info "ROLLBACK FAILED restore ${dest}: $(($r.Err + $r.Out).Trim())"
            continue
        }
        Info "restored $dest mode=$($item.Mode)"
    }
    # verify rollback
    foreach ($item in $doneItems) {
        $dest = $item.Dest
        if ($item.WasAbsent) {
            $r = Invoke-RemoteRc ("test ! -e " + (Remote-Quote $dest)) $null 30000
            if ($r.Code -ne 0) {
                $incomplete = $true
                Info "ROLLBACK VERIFY FAILED path still present: $dest"
            }
            continue
        }
        if ((Get-RemoteMd5 $dest) -cne $item.Md5) {
            $incomplete = $true
            Info "ROLLBACK VERIFY FAILED md5 for $dest"
        }
    }
    if ($incomplete) {
        $script:PreserveStage = $true
        throw "rollback incomplete; staged tree preserved for manual recovery at $Stage. Do NOT reboot (it is in RAM); inspect the staged rollback copies and restore manually."
    }
    Info "rollback verified: all changed paths restored"
    Remove-StagingTree
}

function Remove-StagingTree() {
    if (-not $Stage -or $script:PreserveStage) { return }
    Step "Cleaning owned staging tree"
    $r = Invoke-RemoteRc ("rm -rf " + (Remote-Quote $Stage)) $null 60000
    if ($r.Code -ne 0) {
        Info "warning: could not remove staging tree ${Stage}: $($r.Out.Trim())"
    } else {
        KV "staging_removed=$Stage"
        $script:Stage = ""
    }
}

# ---------------------------------------------------------------- finish

function Invoke-PostWiring() {
    Step "Post-install wiring"
    $binNames = Get-BinManifestNames
    $binChmod = ($binNames | ForEach-Object { "/data/codex/bin/$_" }) -join " "
    $post = "mkdir -p /data/codex/bin /etc/dropbear /home/root/.ssh /data/codexmqtt /pkg/codexactivity /pkg/codexmqtt; " +
        "ln -sf dropbearmulti /data/codex/bin/dropbear; " +
        "ln -sf dropbearmulti /data/codex/bin/dropbearkey; " +
        "chmod 755 $binChmod /data/codex/init.sh /data/codex/offline_egress_guard.sh " +
        "/data/codex/recovery_ap.sh /usr/sbin/dropbear " +
        "/usr/sbin/dropbearkey /etc/init.d/rcS.local; " +
        "chmod 600 /data/codexmqtt/config.json 2>/dev/null || true; " +
        "/bin/busybox sync 2>/dev/null || true"
    Invoke-Remote $post $null 60000 | Out-Null
}

function Start-Services() {
    $start = "killall codex_webui 2>/dev/null || true; killall codex_bthid_keyboard 2>/dev/null || true; " +
        "if ! ps | grep '[o]ffline_egress_guard.sh monitor' >/dev/null 2>&1; then " +
        "/data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 & fi; " +
        "if ! ps | grep '[d]ropbear' >/dev/null 2>&1; then /usr/sbin/dropbear -R -p 22; fi; " +
        "mkdir -p /cache/bin; ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard; " +
        "/data/codex/bin/codex_webui 8080 >> /cache/codex-init.log 2>&1 & " +
        "/data/codex/bin/codex_bthid_keyboard >> /cache/codex-init.log 2>&1 & " +
        "sleep 1; " +
        "/data/codex/bin/codex_hbus $(Remote-Quote $ResolvedHubId) harmony.automation?discover '{""gatewayType"":""codexactivity""}' >> /cache/codex-init.log 2>&1 || true; " +
        "/data/codex/bin/codex_hbus $(Remote-Quote $ResolvedHubId) harmony.automation?discover '{""gatewayType"":""codexmqtt""}' >> /cache/codex-init.log 2>&1 || true; " +
        "ps | grep '[c]odex_webui' || true; ps | grep '[c]odex_bthid_keyboard' || true; ps | grep '[d]ropbear' || true"
    Write-Host (Invoke-Remote $start $null 90000).Trim()
}

function Ensure-ParentDirs() {
    $dirs = @(Get-ActiveCandidates | ForEach-Object {
        $i = $_.Dest.LastIndexOf("/")
        if ($i -le 0) { "/" } else { $_.Dest.Substring(0, $i) }
    } | Sort-Object -Unique)
    $cmd = "mkdir -p " + (($dirs | ForEach-Object { Remote-Quote $_ }) -join " ")
    Invoke-Remote $cmd $null 30000 | Out-Null
}

function Test-CloudBlockerChanged() {
    $cloud = @("/opt/luaworks/tasks/connectserver/netservicestarter.lua", "/data/codex/cloud_blocker.conf")
    return [bool](Get-ActiveCandidates | Where-Object { $cloud -contains $_.Dest })
}

# ------------------------------------------------------------------ main

$HubHost = Prompt-IfMissing $HubHost "Harmony Hub IP address" -Required
$defaultKeyPath = Resolve-DefaultKeyPath
if (-not $KeyPath -and $defaultKeyPath -and (Test-Path -LiteralPath $defaultKeyPath)) {
    $KeyPath = $defaultKeyPath
    Info "using SSH key $KeyPath"
}
$KeyPath = Prompt-IfMissing $KeyPath "SSH private key path for root login" -Required
$KeyPath = (Resolve-Path -LiteralPath $KeyPath).Path
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH key not found: $KeyPath" }

if (-not $NoPrompt -and -not $MqttExplicitSupplied -and -not $MqttDisabled) {
    if ($CleanInstall) {
        $MqttBroker = Read-Host "MQTT broker host/IP (blank to disable MQTT for now)"
        if (-not $MqttBroker) { $MqttDisabled = $true }
        # Only a nonblank broker counts as an explicit MQTT choice; a blank
        # answer must never mark MQTT as explicitly supplied.
        $script:MqttExplicitSupplied = [bool]$MqttBroker
    } else {
        # Default upgrade: never prompt into the MQTT configuration and never
        # regenerate it; the existing /data/codexmqtt/config.json is
        # preserved unless explicit MQTT arguments are supplied.
        $MqttDisabled = $true
    }
}
if (-not $NoPrompt -and $MqttBroker) {
    if (-not $MqttUser) { $MqttUser = Read-Host "MQTT username (blank if none)" }
    if (-not $MqttPassword) { $MqttPassword = Read-Host "MQTT password (blank if none)" }
}

Step "Checking SSH"
$identity = Invoke-Remote "id; uname -a" $null 30000
Write-Host $identity.Trim()

Step "Resolving hub id"
Resolve-HubIdentity

Step "Building candidate inventory"
Build-Inventory
Info "candidates=$($Candidates.Count) (codex_webui installed last)"

# Guaranteed cleanup: any unhandled terminating error removes the owned
# volatile staging tree unless an incomplete rollback preserved it.
trap {
    Remove-StagingTree
    throw $_
}

New-StagingTree
Send-CandidatesToStage
Test-StagedMd5

Invoke-DestinationProbe
Set-UpgradeGates
Get-RamStatus

Count-BackupGenerations
Get-HandoffEstimate
if ($Verdict -eq $VerdictConfigUncertain) {
    Show-PreflightReport
    Remove-StagingTree
    exit 2
}

Build-Plans
Set-Verdict
Show-PreflightReport

if ($PreflightOnly) {
    Remove-StagingTree
    if ($Verdict -eq $VerdictAllowed) { exit 0 } else { exit 2 }
}

if ($Verdict -ne $VerdictAllowed) {
    Remove-StagingTree
    Info "normal mode aborted before any persistent mutation"
    exit 2
}

if ((Get-ActiveCandidates).Count -eq 0) {
    Remove-StagingTree
    Step "Done"
    Info "The hub already matches this payload; nothing was written or restarted."
    exit 0
}

try {
    Add-RollbackCopies
    New-HandoffBackup
    Invoke-HandoffPrune
    Ensure-ParentDirs
    Write-NewCopies
    Install-Sequence
    Test-Installed
} catch [CapacityAbort] {
    $script:Verdict = $VerdictCapacity
    $VerdictReasons.Add($_.Exception.Message) | Out-Null
    KV "verdict_reason=$($_.Exception.Message)"
    Show-Verdict
    Remove-StagingTree
    exit 2
} catch {
    $err = $_.Exception.Message
    $anyDone = [bool]($Changed | Where-Object { $_.Done })
    if ($anyDone -or $NewCopies.Count -gt 0) {
        try {
            Invoke-Rollback $err
        } catch {
            throw $_.Exception.Message
        }
        throw "install failed and was rolled back: $err"
    }
    Remove-StagingTree
    throw
}

try {
    Invoke-PostWiring
    Step "Restarting services"
    Start-Services
} catch {
    # Wiring/start failures after destinations were replaced must
    # reverse-roll back; the rollback material stays intact.
    $err = $_.Exception.Message
    try {
        Invoke-Rollback "post-install wiring/start failed: $err"
        Start-Services
    } catch {
        throw $_.Exception.Message
    }
    throw "post-install wiring/start failed and changes were rolled back: $err"
}
try {
    Wait-TcpPort $HubHost 8080 60 "Web UI"
} catch {
    $err = $_.Exception.Message
    try {
        Invoke-Rollback "smoke test failed: $err"
        Start-Services
    } catch {
        throw $_.Exception.Message
    }
    throw "smoke test failed and changes were rolled back: $err"
}

Remove-StagingTree

$cloudChanged = Test-CloudBlockerChanged
if ($cloudChanged -and -not $NoApplyCloudRestart) {
    Step "Applying cloud blocker"
    Info "Rebooting the hub so Logitech cloud services restart in blocked mode."
    Invoke-Remote "(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting" $null 30000 | Out-Null
    Start-Sleep -Seconds 8
    Wait-TcpPort $HubHost $Port 180 "SSH"
    Wait-TcpPort $HubHost 8080 180 "Web UI"
}

Step "Done"
if ($FirstInstall) {
    Info "Install finished as a first install (configuration written)."
} elseif ($CleanInstall) {
    Info "Install finished in explicit clean-install mode (configuration regenerated)."
} else {
    Info "Install finished in default upgrade mode (existing configuration preserved where applicable)."
}
Info "Persistent paths were mutated only after preflight ALLOWED; staging was volatile until then."
Info "Web UI: http://$HubHost`:8080/"
Info "Web UI authentication: disabled"
if (-not $SkipCloudSuppression) {
    if ($cloudChanged) { Info "Cloud blocker: enabled and applied" } else { Info "Cloud blocker: enabled (unchanged)" }
}
Info "If IR commands do not work, update /data/codex/hub_id with the correct hub id and restart codex_webui."
