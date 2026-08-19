<#
.SYNOPSIS
  Install or upgrade Harmony Hub Control on a rooted Harmony Hub over SSH.
.DESCRIPTION
  Default mode is upgrade and preserves existing configuration.
  -CleanInstall is an explicit clean install that regenerates configuration.
  -PreflightOnly performs volatile staging only under private
  /var/volatile/codex-install-*: it verifies nonsensitive MD5 hashes, runs C
  storage-status/install-plan checks, and prints inventory plus a terminal
  verdict (ALLOWED or BLOCKED_*). It performs no persistent writes, pruning,
  handoff, installs, restarts, or other service actions.

  Normal install still stages every candidate in that private 0700 volatile
  tree and verifies BusyBox md5sum before any persistent mutation, then uses
  the staged codex_webui C engine (--storage-status / --install-plan /
  --install-file / --rollback-restore) for capacity-gated same-directory
  atomic replacements with /mnt/data (or /data) as the authoritative
  statvfs source.
.PARAMETER PreflightOnly
  Volatile preflight only: stage/verify/plan/report under
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
    # -PreflightOnly: volatile stage/verify/plan/report only under /var/volatile/codex-install-*; no persistent mutation or service actions
    [switch]$PreflightOnly,
    # -CleanInstall: explicit clean install regenerating configuration; default without this switch is upgrade preserving existing configuration
    [switch]$CleanInstall
)

$ErrorActionPreference = "Stop"

$FloorBytes = 1048576
$StagePrefix = "/var/volatile/codex-install-"
$HandoffRoot = "/data/codex-backups"
$HandoffBudgetBytes = 256 * 1024
$WebuiDest = "/data/codex/bin/codex_webui"
$DefaultFragmentBytes = 4096

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

function Get-CeilFragment([long]$Size, [long]$Fragment) {
    if ($Size -le 0) { return 0 }
    return [long][Math]::Ceiling([double]$Size / $Fragment) * $Fragment
}

function ConvertFrom-KvLines([string]$Text) {
    $result = @{}
    foreach ($line in ($Text -split "`n")) {
        $line = $line.Trim()
        if (-not $line) { continue }
        $i = $line.IndexOf("=")
        if ($i -le 0) { continue }
        $result[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim()
    }
    return $result
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
$Engine = ""
$Fragment = $DefaultFragmentBytes
$AvailableBytes = -1
$StoragePath = ""
$Candidates = [System.Collections.ArrayList]::new()
$Probe = @{}
$HandoffEstimate = 0
$HandoffReservation = 0
$ForwardTotal = 0
$RollbackTotal = 0
$RequiredTotal = 0
$Verdict = $VerdictValidation
$VerdictReasons = [System.Collections.ArrayList]::new()
$Generations = @{ handoff = 0; resource = 0; settings = 0; update = 0 }
$Changed = [System.Collections.ArrayList]::new()
$ResolvedHubId = ""
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
        ForwardReservation = 0
        RollbackReservation = 0
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

function New-StagingTree() {
    Step "Creating private staging tree"
    $cmd = "D=`$(mktemp -d $StagePrefix" + "XXXXXX 2>/dev/null) || exit 1; chmod 700 `"`$D`" || exit 1; echo `"`$D`""
    $out = (Invoke-Remote $cmd $null 30000).Trim()
    if (-not $out.StartsWith($StagePrefix) -or $out.Contains("..") -or ($out.ToCharArray() | Where-Object { $_ -eq '/' }).Count -ne 3) {
        throw "unsafe staging path from mktemp: $out"
    }
    $script:Stage = $out
    KV "staging_dir=$out"
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

# ------------------------------------------------------------- discovery

function Get-StagedWebui() {
    foreach ($cand in $Candidates) {
        if ($cand.Dest -eq $WebuiDest) { return "$Stage/$($cand.StagedName)" }
    }
    throw "codex_webui candidate missing from inventory"
}

function Get-EnginePath() {
    # Candidates stay at 0600 per contract; the C engine itself must be
    # executable to run the staged maintenance modes, so use a verified
    # 0700 copy.
    if ($script:Engine) { return $script:Engine }
    $source = Get-StagedWebui
    $engine = "$Stage/engine-" + $source.Split('/')[-1]
    $cmd = "cp -p $(Remote-Quote $source) $(Remote-Quote $engine) && chmod 700 $(Remote-Quote $engine) && md5sum $(Remote-Quote $engine)"
    $out = Invoke-Remote $cmd $null 60000
    $last = ($out.Trim() -split "`n")[-1].Trim()
    $md5Re = '^[0-9a-f]{32}  .+$'
    $expected = ($Candidates | Where-Object { $_.Dest -eq $WebuiDest }).Md5
    if (($last -cnotmatch $md5Re) -or (($last -split "  ", 2)[0] -cne $expected)) {
        throw "staged engine copy failed md5 verification"
    }
    $script:Engine = $engine
    return $engine
}

function Invoke-StagedC([string[]]$Arguments, [int]$TimeoutMs = 120000) {
    $binary = Get-EnginePath
    $cmd = (Remote-Quote $binary) + " " + (($Arguments | ForEach-Object { Remote-Quote $_ }) -join " ")
    $r = Invoke-RemoteRc $cmd $null $TimeoutMs
    return @{ Code = $r.Code; Out = ($r.Out + $r.Err) }
}

function ConvertFrom-FileStatus([string]$Destination, $Parsed, [string]$Raw) {
    # Strict validation of one staged-C --file-status record into the probe
    # shape @{ kind; size; mode(octal string); md5 }. Fails closed on any
    # unexpected or missing field.
    $context = "file-status for $Destination"
    if ($Parsed["operation"] -cne "file-status") { throw "$context reported unexpected operation:`n$($Raw.Trim())" }
    if ($Parsed["ok"] -cne "1") { throw "$context failed: reason=$($Parsed['reason'])" }
    if ($Parsed["destination"] -cne $Destination) { throw "$context echoed wrong destination:`n$($Raw.Trim())" }
    if ($Parsed["allowed"] -cne "1") { throw "$context refused: reason=$($Parsed['reason'])" }
    $exists = $Parsed["exists"]
    $kind = $Parsed["type"]
    if ($exists -notin @("0", "1") -or $kind -notin @("absent", "regular", "symlink", "other")) {
        throw "$context reported invalid exists/type:`n$($Raw.Trim())"
    }
    $size = 0; $alloc = 0; $modeDec = 0
    if (-not [long]::TryParse($Parsed["bytes"], [ref]$size)) { throw "$context invalid bytes:`n$($Raw.Trim())" }
    if (-not [long]::TryParse($Parsed["allocated_bytes"], [ref]$alloc)) { throw "$context invalid allocated_bytes:`n$($Raw.Trim())" }
    if (-not [long]::TryParse($Parsed["mode_decimal"], [ref]$modeDec)) { throw "$context invalid mode_decimal:`n$($Raw.Trim())" }
    $md5 = [string]$Parsed["md5"]
    if ($md5 -cne "none" -and $md5 -cnotmatch '^[0-9a-f]{32}$') {
        throw "$context reported invalid md5:`n$($Raw.Trim())"
    }
    if ($exists -eq "0") {
        if ($kind -cne "absent") { throw "$context exists=0 without type=absent:`n$($Raw.Trim())" }
        return @{ kind = "absent"; size = "0"; mode = ""; md5 = "" }
    }
    if ($kind -cne "regular") {
        return @{ kind = $kind; size = "0"; mode = ""; md5 = "" }
    }
    if ($md5 -cnotmatch '^[0-9a-f]{32}$') { throw "$context regular file without a computed md5:`n$($Raw.Trim())" }
    return @{
        kind = "regular"
        size = [string]$size
        mode = [Convert]::ToString([int]$modeDec, 8)
        md5 = $md5
    }
}

function Get-DestinationFileStatus([string]$Destination) {
    $r = Invoke-StagedC @("--file-status", $Destination)
    $parsed = ConvertFrom-KvLines $r.Out
    $state = ConvertFrom-FileStatus $Destination $parsed $r.Out
    if ($r.Code -ne 0) { throw "file-status nonzero exit for $Destination (exit $($r.Code))" }
    return $state
}

function Invoke-DestinationProbe() {
    Step "Probing destination state (staged C --file-status)"
    $dests = @($Candidates | ForEach-Object { $_.Dest })
    foreach ($p in $HandoffRequiredPaths) { if ($dests -notcontains $p) { $dests += $p } }
    foreach ($dest in $dests) {
        $state = $null
        try {
            $state = Get-DestinationFileStatus $dest
        } catch {
            Stop-WithValidation $_.Exception.Message
        }
        $script:Probe[$dest] = $state
    }
}

function Stop-WithValidation([string]$Reason) {
    $script:Verdict = $VerdictValidation
    $VerdictReasons.Add($Reason) | Out-Null
    throw $Reason
}

function Resolve-HubIdentity() {
    $hubId = $HubId
    if (-not $hubId) {
        $existing = (Invoke-Remote "cat /data/codex/hub_id 2>/dev/null || true" $null 30000).Trim()
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

function Get-StorageStatus([long]$Floor) {
    $r = Invoke-StagedC @("--storage-status", [string]$Floor)
    $parsed = ConvertFrom-KvLines $r.Out
    if ($r.Code -ne 0 -and -not $parsed.Contains("available_bytes")) {
        throw "staged codex_webui --storage-status failed (exit $($r.Code)):`n$($r.Out.Trim())"
    }
    if (-not $parsed.Contains("available_bytes")) {
        throw "storage-status did not report available_bytes:`n$($r.Out.Trim())"
    }
    $script:AvailableBytes = [long]$parsed["available_bytes"]
    if ($parsed.Contains("storage_path")) { $script:StoragePath = $parsed["storage_path"] }
    if ($parsed.Contains("fragment_bytes")) { $script:Fragment = [long]$parsed["fragment_bytes"] }
    return $parsed
}

function Build-Plans() {
    Step "Building capacity plans per destination"
    $script:ForwardTotal = 0
    $script:RollbackTotal = 0
    $planShortfall = $false
    foreach ($cand in $Candidates) {
        if ($cand.Action -notin @("replace", "create")) { continue }
        $r = Invoke-StagedC @("--install-plan", "$Stage/$($cand.StagedName)", $cand.Dest, $cand.Mode, [string]$FloorBytes)
        $parsed = ConvertFrom-KvLines $r.Out
        # C returns exit 1 for a capacity shortfall while still emitting ok=1
        # with the complete reservation fields. Accept that truthful refusal
        # and classify it as capacity; any other nonzero (ok=0: mode/floor/
        # allowlist/evaluate refusal) is a validation failure.
        $ok = $parsed.Contains("ok") -and ($parsed["ok"] -eq "1")
        if (-not $ok) {
            Stop-WithValidation "install-plan failed for $($cand.Dest) (exit $($r.Code)):`n$($r.Out.Trim())"
        }
        $capacityRefusal = ($r.Code -ne 0) -and $parsed.Contains("sufficient") -and ($parsed["sufficient"] -eq "0")
        if (($r.Code -ne 0) -and -not $capacityRefusal) {
            Stop-WithValidation "install-plan failed for $($cand.Dest) (exit $($r.Code)):`n$($r.Out.Trim())"
        }
        if (-not $parsed.Contains("candidate_reservation_bytes") -or -not $parsed.Contains("rollback_reservation_bytes")) {
            Stop-WithValidation "install-plan for $($cand.Dest) missing reservation keys:`n$($r.Out.Trim())"
        }
        $cand.ForwardReservation = [long]$parsed["candidate_reservation_bytes"]
        $cand.RollbackReservation = [long]$parsed["rollback_reservation_bytes"]
        if ($capacityRefusal) {
            $available = $parsed["available_bytes"]
            if (-not $available) { $available = "?" }
            $required = $parsed["required_bytes"]
            if (-not $required) { $required = "?" }
            $VerdictReasons.Add("install-plan insufficient for $($cand.Dest): available $available < required $required (exit $($r.Code), sufficient=0)") | Out-Null
            $planShortfall = $true
        }
        $script:ForwardTotal += $cand.ForwardReservation
        $script:RollbackTotal += $cand.RollbackReservation
        $existsFlag = 0
        if ($cand.Action -eq "replace") { $existsFlag = 1 }
        KV "destination dest=$($cand.Dest) exists=$existsFlag action=$($cand.Action) bytes=$($cand.Bytes) mode=$($cand.Mode) forward_reservation_bytes=$($cand.ForwardReservation) rollback_reservation_bytes=$($cand.RollbackReservation)"
    }
    if ($planShortfall) {
        # Truthful classification: any per-candidate shortfall blocks on
        # capacity before Set-Verdict's aggregate comparison.
        $script:Verdict = $VerdictCapacity
    }
}

function Count-BackupGenerations() {
    $cmd = 'for d in /data/codex-backups /data/codex/resource-backups /data/codex/update-backups; do [ -d "$d" ] || continue; for n in "$d"/*; do [ -e "$n" ] && echo "$n"; done; done'
    $out = Invoke-Remote $cmd $null 30000
    foreach ($line in ($out -split "`n")) {
        $name = $line.Trim().Split('/')[-1]
        if (-not $name) { continue }
        if ($name -match '^webui-handoff-\d{8}-\d{6}$') { $Generations["handoff"]++ }
        elseif ($name -match '^settings_\d{8}_\d{6}$') { $Generations["settings"]++ }
        elseif ($name -match '^\d{8}_\d{6}$') { $Generations["resource"]++ }
        elseif ($name -match '^\d+$') { $Generations["update"]++ }
    }
}

function Get-HandoffEstimate() {
    $total = 0
    $reservation = 0
    foreach ($path in $HandoffRequiredPaths) {
        if ($Probe.Contains($path) -and $Probe[$path]["kind"] -eq "regular") {
            $size = [long]$Probe[$path]["size"]
            $total += $size
            $reservation += (Get-CeilFragment $size $Fragment) + $Fragment
        }
    }
    $script:HandoffEstimate = $total
    $script:HandoffReservation = $reservation
}

function Set-Verdict() {
    if ($Verdict -eq $VerdictConfigUncertain) { return }
    $script:RequiredTotal = $FloorBytes + $HandoffReservation + $ForwardTotal + $RollbackTotal
    if ($Verdict -eq $VerdictCapacity) {
        # Per-candidate plan shortfall already classified truthfully.
        return
    }
    if ($AvailableBytes -lt ($FloorBytes + $HandoffReservation + $ForwardTotal)) {
        $script:Verdict = $VerdictCapacity
        $VerdictReasons.Add("available $AvailableBytes < floor+handoff+forward $($FloorBytes + $HandoffReservation + $ForwardTotal)") | Out-Null
    } elseif ($AvailableBytes -lt $RequiredTotal) {
        $script:Verdict = $VerdictRollbackCapacity
        $VerdictReasons.Add("available $AvailableBytes < total required incl. rollback $RequiredTotal") | Out-Null
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
        Info "Mode: -PreflightOnly — stages, verifies, plans capacity, and prints a terminal verdict; performs no persistent writes and no service actions."
    }
    if ($CleanInstall) {
        Info "Install mode: explicit clean install — configuration candidates are regenerated."
    } else {
        Info "Install mode: default upgrade — existing configuration is preserved unless a candidate explicitly replaces it."
    }
    $mode = "upgrade"
    if ($CleanInstall) { $mode = "clean" }
    KV "preflight_mode=$mode"
    KV "candidate_count=$($Candidates.Count)"
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
    KV "handoff_reservation_bytes=$HandoffReservation"
    KV "storage_path=$StoragePath"
    KV "available_bytes=$AvailableBytes"
    KV "fragment_bytes=$Fragment"
    KV "floor_bytes=$FloorBytes"
    KV "forward_total_bytes=$ForwardTotal"
    KV "rollback_total_bytes=$RollbackTotal"
    KV "required_total_bytes=$RequiredTotal"
    Info "Capacity summary: available=$AvailableBytes floor=$FloorBytes forward=$ForwardTotal rollback=$RollbackTotal required_total=$RequiredTotal storage_path=$(if ($StoragePath) { $StoragePath } else { '(unset)' })"
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
        Info "ALLOWED — capacity, rollback reservation, and validation are sufficient for the selected mode."
        if ($PreflightOnly) {
            Info "Preflight-only complete: volatile staging will be removed; no persistent changes or service actions were performed."
        } else {
            Info "Persistent install may proceed after this report (atomic same-directory replacements via staged C engine)."
        }
    } elseif ($Verdict -eq $VerdictCapacity) {
        Info "BLOCKED_CAPACITY — free space is below the floor plus handoff and forward candidate reservations. No persistent changes."
    } elseif ($Verdict -eq $VerdictRollbackCapacity) {
        Info "BLOCKED_ROLLBACK_CAPACITY — free space covers forward install reservations but not the additional rollback reservation. No persistent changes."
    } elseif ($Verdict -eq $VerdictConfigUncertain) {
        Info "BLOCKED_CONFIGURATION_UNCERTAINTY — required configuration state is missing or ambiguous for default upgrade; pass -HubId or use -CleanInstall. No persistent changes."
    } else {
        Info "BLOCKED_VALIDATION_FAILURE — staging, path, hash, or plan validation failed; see verdict_reason lines above. No persistent changes."
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
            # Flat leaf under the staging dir: C requires SOURCE
            # /var/volatile/codex-install-<dir>/<leaf>.
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
                CanonicalMode = $cand.Mode
                Md5 = $state["md5"]
                Rb = $rb
                Bytes = [long]$state["size"]
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
                CanonicalMode = $cand.Mode
                Md5 = ""
                Rb = ""
                Bytes = 0
                WasAbsent = $true
                Done = $false
            }) | Out-Null
        }
    }
}

function Invoke-Retention([string]$Label) {
    Step $Label
    $r = Invoke-StagedC @("--prune-backups")
    foreach ($line in ($r.Out.Trim() -split "`n")) { Info $line }
    if ($r.Code -ne 0 -and $r.Out -notmatch "over_budget=1 errors=0") {
        throw "staged --prune-backups failed (exit $($r.Code))"
    }
}

function New-HandoffBackup() {
    Step "Creating bounded handoff backup"
    # Sizes come from the staged C probe (no remote shell stat). The shell
    # only copies and accumulates installer-supplied sizes; the budget guard
    # remains on the hub side.
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
    $handoffSeen = $false
    foreach ($line in ($out.Trim() -split "`n")) {
        Info $line
        if ($line.StartsWith("handoff=")) { $handoffSeen = $true }
    }
    if (-not $handoffSeen) { throw "handoff directory rename did not complete" }
}

function Install-Sequence() {
    Step "Installing candidates (staged C atomic replace, codex_webui last)"
    $active = @($Candidates | Where-Object { $_.Action -in @("replace", "create") })
    $reservations = @($active | ForEach-Object { $_.ForwardReservation + $_.RollbackReservation })
    for ($pos = 0; $pos -lt $active.Count; $pos++) {
        $cand = $active[$pos]
        $rest = 0
        for ($j = $pos + 1; $j -lt $reservations.Count; $j++) { $rest += $reservations[$j] }
        # The handoff was already written and consumed its reservation on the
        # same authoritative backing; per-file floors after handoff are
        # floor + remaining reservations only.
        $floor = $FloorBytes + $rest
        $r = Invoke-StagedC @("--install-file", "$Stage/$($cand.StagedName)", $cand.Dest, $cand.Mode, [string]$floor) 180000
        $parsed = ConvertFrom-KvLines $r.Out
        if ($parsed.Contains("rename_completed") -and ($parsed["rename_completed"] -eq "1")) {
            # The destination was replaced even though C reported a nonzero
            # outcome (post-write measurement/floor failure): record it as
            # changed so rollback restores the original.
            foreach ($item in $Changed) { if ($item.Dest -eq $cand.Dest) { $item.Done = $true } }
        }
        # Fail closed: nonzero exit, missing/unrecognized result, or a
        # completed write whose post-write outcome is bad all abort.
        $result = $null
        if ($parsed.Contains("result")) { $result = $parsed["result"] }
        $resultOk = ($result -eq "installed") -or ($result -eq "no-op")
        if ($r.Code -ne 0 -or -not $resultOk) {
            throw "install-file failed for $($cand.Dest) (exit $($r.Code)):`n$($r.Out.Trim())"
        }
        if ($result -eq "installed") {
            if (-not $parsed.Contains("errors") -or ($parsed["errors"] -ne "0")) {
                throw "install-file post-write outcome failed for $($cand.Dest):`n$($r.Out.Trim())"
            }
            if ($parsed.Contains("available_bytes_after")) {
                $after = -1
                try { $after = [long]$parsed["available_bytes_after"] } catch { $after = -1 }
                $floorAfterOk = $parsed.Contains("floor_met_after") -and ($parsed["floor_met_after"] -eq "1")
                if (($after -lt 0) -or ($after -lt $FloorBytes) -or -not $floorAfterOk) {
                    throw "install-file post-write floor failed for $($cand.Dest):`n$($r.Out.Trim())"
                }
            }
        }
        foreach ($item in $Changed) { if ($item.Dest -eq $cand.Dest) { $item.Done = $true } }
        Info "installed dest=$($cand.Dest) mode=$($cand.Mode) bytes=$($cand.Bytes)"
    }
}

function Test-Installed() {
    Step "Verifying installed bytes, hashes, modes, and storage (staged C --file-status)"
    $active = @($Candidates | Where-Object { $_.Action -in @("replace", "create") })
    foreach ($cand in $active) {
        $state = Get-DestinationFileStatus $cand.Dest
        if ($state["kind"] -cne "regular") {
            throw "post-install verification failed for $($cand.Dest): kind=$($state['kind'])"
        }
        if ([long]$state["size"] -ne [long]$cand.Bytes) {
            throw "post-install byte mismatch for $($cand.Dest): expected $($cand.Bytes) got $($state['size'])"
        }
        if ($state["md5"] -cne $cand.Md5) {
            throw "post-install checksum mismatch for $($cand.Dest)"
        }
        $gotMode = -1
        try { $gotMode = [Convert]::ToInt32($state["mode"], 8) } catch { $gotMode = -1 }
        if ($gotMode -ne [Convert]::ToInt32($cand.Mode, 8)) {
            throw "post-install mode mismatch for $($cand.Dest): expected $($cand.Mode) got $($state['mode'])"
        }
    }
    Get-StorageStatus $FloorBytes | Out-Null
    Info "installed candidates verified; storage rechecked"
}

function Invoke-Rollback([string]$Trigger) {
    Step "Rolling back changed paths"
    Info "trigger: $Trigger"
    $md5Re = '^[0-9a-f]{32}  .+$'
    $doneItems = @($Changed | Where-Object { $_.Done })
    $pending = @($doneItems)
    [Array]::Reverse($pending)
    $restoreItems = @($pending | Where-Object { -not $_.WasAbsent })
    $reservations = @($restoreItems | ForEach-Object { (Get-CeilFragment ([long]$_.Bytes) $Fragment) + $Fragment })
    $incomplete = $false
    foreach ($item in $pending) {
        $dest = $item.Dest
        if ($item.WasAbsent) {
            $r = Invoke-RemoteRc ("rm -f " + (Remote-Quote $dest)) $null 30000
            if ($r.Code -ne 0) {
                $incomplete = $true
                Info "ROLLBACK FAILED remove new path ${dest}: $($r.Out.Trim())"
                continue
            }
            $r = Invoke-RemoteRc ("test ! -e " + (Remote-Quote $dest)) $null 30000
            if ($r.Code -ne 0) {
                $incomplete = $true
                Info "ROLLBACK FAILED path still present after remove: $dest"
                continue
            }
            Info "removed new path $dest (original absence recorded)"
            continue
        }
        $index = [Array]::IndexOf($restoreItems, $item)
        # Caller floor = 1048576 plus all later reverse restorations.
        $rest = 0
        for ($j = $index + 1; $j -lt $reservations.Count; $j++) { $rest += $reservations[$j] }
        $floor = $FloorBytes + $rest
        # C requires MODE to equal the destination's canonical allowlist
        # mode; the observed pre-install mode is restored afterwards.
        $r = Invoke-StagedC @("--install-file", [string]$item.Rb, $dest, [string]$item.CanonicalMode, [string]$floor, "--rollback-restore") 180000
        if ($r.Code -ne 0) {
            $incomplete = $true
            Info "ROLLBACK FAILED restore ${dest}: $($r.Out.Trim())"
            continue
        }
        if ([string]$item.Mode -ne [string]$item.CanonicalMode) {
            $rc = Invoke-RemoteRc ("chmod " + (Remote-Quote ([string]$item.Mode)) + " " + (Remote-Quote $dest)) $null 30000
            if ($rc.Code -ne 0) {
                $incomplete = $true
                Info "ROLLBACK FAILED mode restore ${dest}: $($rc.Out.Trim())"
                continue
            }
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
        $r = Invoke-RemoteRc ("md5sum " + (Remote-Quote $dest)) $null 60000
        $first = ($r.Out.Trim() -split "`n")[0].Trim()
        $ok = ($r.Code -eq 0) -and ($first -cmatch $md5Re)
        if ($ok) { $ok = (($first -split "  ", 2)[0] -ceq $item.Md5) }
        if (-not $ok) {
            $incomplete = $true
            Info "ROLLBACK VERIFY FAILED md5 for $dest"
        }
    }
    if ($incomplete) {
        $script:PreserveStage = $true
        throw "rollback incomplete; staged tree preserved for manual recovery at $Stage. Do NOT reboot; inspect the staged rollback copies and restore manually."
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
        "/data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 & " +
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
    $dirs = @($Candidates | Where-Object { $_.Action -in @("replace", "create") } | ForEach-Object {
        $i = $_.Dest.LastIndexOf("/")
        if ($i -le 0) { "/" } else { $_.Dest.Substring(0, $i) }
    } | Sort-Object -Unique)
    $cmd = "mkdir -p " + (($dirs | ForEach-Object { Remote-Quote $_ }) -join " ")
    Invoke-Remote $cmd $null 30000 | Out-Null
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

Step "Querying authoritative storage status"
$status = Get-StorageStatus $FloorBytes
foreach ($key in ($status.Keys | Sort-Object)) { KV "storage $key=$($status[$key])" }

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

try {
    Add-RollbackCopies
    Invoke-Retention "Step 3 retention (before handoff)"
    New-HandoffBackup
    Invoke-Retention "Step 3 retention (after handoff)"
    # The handoff reservation was consumed by the handoff itself on the same
    # authoritative backing; recheck against the remaining floor + forward +
    # rollback only (never re-charge the handoff).
    $postHandoffRequired = $FloorBytes + $ForwardTotal + $RollbackTotal
    Step "Rechecking storage after retention and handoff"
    Get-StorageStatus ([Math]::Max($FloorBytes, $postHandoffRequired)) | Out-Null
    if ($AvailableBytes -lt $postHandoffRequired) {
        throw "storage recheck failed: available $AvailableBytes < required $postHandoffRequired"
    }
    Ensure-ParentDirs
    Install-Sequence
    Test-Installed
} catch {
    $err = $_.Exception.Message
    $anyDone = [bool]($Changed | Where-Object { $_.Done })
    if ($anyDone) {
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

if (-not $SkipCloudSuppression -and -not $NoApplyCloudRestart) {
    Step "Applying cloud blocker"
    Info "Rebooting the hub so Logitech cloud services restart in blocked mode."
    Invoke-Remote "(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting" $null 30000 | Out-Null
    Start-Sleep -Seconds 8
    Wait-TcpPort $HubHost $Port 180 "SSH"
    Wait-TcpPort $HubHost 8080 180 "Web UI"
}

Step "Done"
if ($CleanInstall) {
    Info "Install finished in explicit clean-install mode (configuration regenerated)."
} else {
    Info "Install finished in default upgrade mode (existing configuration preserved where applicable)."
}
Info "Persistent paths were mutated only after preflight ALLOWED; staging was volatile until then."
Info "Web UI: http://$HubHost`:8080/"
Info "Web UI authentication: disabled"
if (-not $SkipCloudSuppression) {
    Info "Cloud blocker: enabled and applied"
}
Info "If IR commands do not work, update /data/codex/hub_id with the correct hub id and restart codex_webui."
