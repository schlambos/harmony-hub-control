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
    [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"

function Step($Text) {
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Info($Text) {
    Write-Host "  $Text"
}

function Prompt-IfMissing([string]$Value, [string]$Label, [switch]$Required) {
    if ($Value) { return $Value }
    if ($NoPrompt) {
        if ($Required) { throw "$Label is required" }
        return ""
    }
    $v = Read-Host $Label
    if ($Required -and -not $v) { throw "$Label is required" }
    return $v
}

function Resolve-DefaultKeyPath() {
    $userHome = $env:USERPROFILE
    if (-not $userHome) { $userHome = [Environment]::GetFolderPath("UserProfile") }
    if (-not $userHome) { return "" }
    $sshDir = Join-Path $userHome ".ssh"
    if (-not (Test-Path -LiteralPath $sshDir -PathType Container -ErrorAction SilentlyContinue)) { return "" }
    $keys = @(Get-ChildItem -LiteralPath $sshDir -File -Filter "harmony_owner_*" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike "*.pub" } |
        Sort-Object LastWriteTime -Descending)
    if ($keys.Count -lt 1) { return "" }
    return $keys[0].FullName
}

function Test-HubId([string]$Value) {
    return [bool]($Value -match '^[0-9]{4,}$')
}

function Get-UniquePathList([string[]]$Paths) {
    $seen = @{}
    $out = @()
    foreach ($path in $Paths) {
        if (-not $path) { continue }
        if ($seen.ContainsKey($path)) { continue }
        $seen[$path] = $true
        $out += $path
    }
    return $out
}

function Resolve-SavedHubId([string]$HubHost) {
    $userRoot = $env:USERPROFILE
    if (-not $userRoot) { $userRoot = [Environment]::GetFolderPath("UserProfile") }
    $paths = @()
    if ($userRoot) {
        $paths += Join-Path $userRoot ".harmony-hub\known_hubs.json"
        $paths += Join-Path $userRoot ".harmony-hub\last_root.json"
        $paths += Join-Path $userRoot ".harmony-hub\hub_id.txt"
    }
    if ($HOME -and $HOME -ne $userRoot) {
        $paths += Join-Path $HOME ".harmony-hub\known_hubs.json"
        $paths += Join-Path $HOME ".harmony-hub\last_root.json"
        $paths += Join-Path $HOME ".harmony-hub\hub_id.txt"
    }
    $paths += Join-Path $ScriptRoot "harmony_hub_id.txt"

    foreach ($path in (Get-UniquePathList $paths)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf -ErrorAction SilentlyContinue)) { continue }
        try {
            if ($path.EndsWith("known_hubs.json")) {
                $known = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
                $entry = $known.PSObject.Properties[$HubHost].Value
                if ($entry -and (Test-HubId $entry.hub_id)) {
                    return [pscustomobject]@{ HubId = [string]$entry.hub_id; Source = $path }
                }
            } elseif ($path.EndsWith("last_root.json")) {
                $last = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
                if ($last.host -eq $HubHost -and (Test-HubId $last.hub_id)) {
                    return [pscustomobject]@{ HubId = [string]$last.hub_id; Source = $path }
                }
            } else {
                $value = (Get-Content -LiteralPath $path -Raw).Trim()
                if (Test-HubId $value) {
                    return [pscustomobject]@{ HubId = $value; Source = $path }
                }
            }
        } catch {
            Info "ignored unreadable Hub ID handoff file ${path}: $($_.Exception.Message)"
        }
    }
    return $null
}

function Quote-ProcessArg([string]$Arg) {
    if ($null -eq $Arg) { return '""' }
    if ($Arg.Length -eq 0) { return '""' }
    if ($Arg -notmatch '[\s"]') { return $Arg }
    $out = '"'
    $slashes = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq '\') {
            $slashes += 1
            continue
        }
        if ($ch -eq '"') {
            $out += ('\' * (($slashes * 2) + 1)) + '"'
            $slashes = 0
            continue
        }
        if ($slashes) {
            $out += ('\' * $slashes)
            $slashes = 0
        }
        $out += $ch
    }
    if ($slashes) { $out += ('\' * ($slashes * 2)) }
    return $out + '"'
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

function Invoke-Remote([string]$Command, [byte[]]$InputBytes = $null, [int]$TimeoutMs = 90000) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "ssh"
    $allArgs = (Get-SshArgs) + @($Command)
    $psi.Arguments = ($allArgs | ForEach-Object { Quote-ProcessArg $_ }) -join " "
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($psi)
    if ($InputBytes) {
        $p.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
    }
    $p.StandardInput.BaseStream.Close()
    if (-not $p.WaitForExit($TimeoutMs)) {
        try { $p.Kill() } catch {}
        throw "ssh timed out while running: $Command"
    }
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    if ($p.ExitCode -ne 0) {
        throw "ssh failed with exit $($p.ExitCode)`ncommand=$Command`nstdout=$stdout`nstderr=$stderr"
    }
    if ($stderr.Trim()) {
        Write-Host $stderr.Trim() -ForegroundColor DarkGray
    }
    return $stdout
}

function Test-TcpPort([string]$TargetHost, [int]$TargetPort, [int]$TimeoutMs = 1200) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect($TargetHost, $TargetPort, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch {}
    }
}

function Wait-TcpPort([string]$TargetHost, [int]$TargetPort, [int]$Seconds, [string]$Label) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-TcpPort $TargetHost $TargetPort 1200) {
            Info "$Label is reachable on port $TargetPort"
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "$Label did not become reachable on port $TargetPort within $Seconds seconds"
}

function Split-RemoteDir([string]$Path) {
    $i = $Path.LastIndexOf("/")
    if ($i -le 0) { return "/" }
    return $Path.Substring(0, $i)
}

function Upload-Bytes([string]$LocalPath, [string]$RemotePath, [string]$Mode) {
    if (-not (Test-Path -LiteralPath $LocalPath)) { throw "missing local file: $LocalPath" }
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $LocalPath))
    $dir = Split-RemoteDir $RemotePath
    $tmp = "$RemotePath.tmp-handoff-$PID"
    $cmd = "mkdir -p $(Remote-Quote $dir) && cat > $(Remote-Quote $tmp) && mv $(Remote-Quote $tmp) $(Remote-Quote $RemotePath) && chmod $Mode $(Remote-Quote $RemotePath)"
    Invoke-Remote $cmd $bytes ([Math]::Max(90000, 45000 + [int]($bytes.Length / 12000))) | Out-Null
    $md5 = (Get-FileHash -Algorithm MD5 -LiteralPath $LocalPath).Hash.ToLowerInvariant()
    Info "$RemotePath bytes=$($bytes.Length) md5=$md5"
}

function Upload-Text([string]$Text, [string]$RemotePath, [string]$Mode) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $dir = Split-RemoteDir $RemotePath
    $tmp = "$RemotePath.tmp-handoff-$PID"
    $cmd = "mkdir -p $(Remote-Quote $dir) && cat > $(Remote-Quote $tmp) && mv $(Remote-Quote $tmp) $(Remote-Quote $RemotePath) && chmod $Mode $(Remote-Quote $RemotePath)"
    Invoke-Remote $cmd $bytes 90000 | Out-Null
    if ($RemotePath -match "pass|authorized_keys") {
        Info "$RemotePath bytes=$($bytes.Length) md5=<hidden>"
    } else {
        $md5 = [System.BitConverter]::ToString([System.Security.Cryptography.MD5]::Create().ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
        Info "$RemotePath bytes=$($bytes.Length) md5=$md5"
    }
}

function Build-MqttConfig() {
    $enabled = (-not $MqttDisabled) -and [bool]$MqttBroker
    $cfg = [ordered]@{
        enabled = $enabled
        name = "Harmony Hub"
        clientId = $MqttClientId
        baseTopic = $MqttBaseTopic.Trim("/")
        discoveryPrefix = $MqttDiscoveryPrefix.Trim("/")
        haDiscovery = $true
        pollSeconds = 10
        keepAlive = 60
        broker = [ordered]@{
            host = $MqttBroker
            port = $MqttPort
            username = $MqttUser
            password = $MqttPassword
        }
    }
    return ($cfg | ConvertTo-Json -Compress -Depth 8) + "`n"
}

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Payload = Join-Path $ScriptRoot "payload"

$HubHost = Prompt-IfMissing $HubHost "Harmony hub IP address" -Required
$defaultKeyPath = Resolve-DefaultKeyPath
if (-not $KeyPath -and $defaultKeyPath -and (Test-Path -LiteralPath $defaultKeyPath)) {
    $KeyPath = $defaultKeyPath
    Info "using SSH key $KeyPath"
}
$KeyPath = Prompt-IfMissing $KeyPath "SSH private key path for root login" -Required
$KeyPath = (Resolve-Path -LiteralPath $KeyPath).Path
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH key not found: $KeyPath" }

if (-not $NoPrompt -and -not $MqttBroker -and -not $MqttDisabled) {
    $MqttBroker = Read-Host "MQTT broker host/IP (blank to disable MQTT for now)"
    if (-not $MqttBroker) { $MqttDisabled = $true }
}
if (-not $NoPrompt -and $MqttBroker) {
    if (-not $MqttUser) { $MqttUser = Read-Host "MQTT username (blank if none)" }
    if (-not $MqttPassword) { $MqttPassword = Read-Host "MQTT password (blank if none)" }
}

Step "Checking SSH"
$identity = Invoke-Remote "id; uname -a" $null 30000
Write-Host $identity.Trim()

if (-not $HubId) {
    $existingHubId = (Invoke-Remote "cat /data/codex/hub_id 2>/dev/null || true" $null 30000).Trim()
    if ($existingHubId) {
        $HubId = $existingHubId
        Info "hub id from existing /data/codex/hub_id: $HubId"
    } else {
        $savedHub = Resolve-SavedHubId $HubHost
        if ($savedHub) {
            $HubId = $savedHub.HubId
            Info "hub id from root-tool handoff: $HubId ($($savedHub.Source))"
        }
    }
}
if (-not (Test-HubId $HubId)) {
    if ($HubId) {
        throw "Invalid Hub ID '$HubId'. Re-run the root tool or pass the numeric Hub ID with -HubId."
    } elseif (-not $NoPrompt) {
        throw "Hub ID is required. Re-run the root tool so it writes the handoff file, or pass -HubId with the numeric value printed as hub_id=..."
    }
}
if (-not $HubId) {
    throw "Hub ID is required. Re-run the root tool so it writes the handoff file, or pass -HubId with the numeric value printed as hub_id=..."
}
Info "using hub id $HubId"

Step "Creating remote backup"
$backupCmd = 'STAMP=$(date +%Y%m%d-%H%M%S); B=/data/codex-backups/webui-handoff-$STAMP; mkdir -p "$B"; for f in /etc/init.d/rcS.local /opt/luaworks/tasks/connectserver/netservicestarter.lua /usr/sbin/dropbear /usr/sbin/dropbearkey /data/codex/hub_id /data/codex/cloud_blocker.conf /data/codex/offline_egress_guard.sh /data/codexmqtt/config.json /pkg/codexactivity/codexactivity.lua /pkg/codexactivity/manifest.json; do if [ -e "$f" ]; then n=$(echo "$f" | sed ''s#/#_#g''); cp -p "$f" "$B/$n"; fi; done; echo "$B"'
$backupDir = (Invoke-Remote $backupCmd $null 30000).Trim()
Info "backup=$backupDir"

Step "Uploading binaries"
Upload-Bytes (Join-Path $Payload "bin\dropbearmulti") "/data/codex/bin/dropbearmulti" "755"
Upload-Bytes (Join-Path $Payload "bin\codex_dhcpd") "/data/codex/bin/codex_dhcpd" "755"
Upload-Bytes (Join-Path $Payload "bin\codex_hbus") "/data/codex/bin/codex_hbus" "755"
Upload-Bytes (Join-Path $Payload "bin\codex_hal_ltcp") "/data/codex/bin/codex_hal_ltcp" "755"
Upload-Bytes (Join-Path $Payload "bin\codex_bthid_keyboard") "/data/codex/bin/codex_bthid_keyboard" "755"
Upload-Bytes (Join-Path $Payload "bin\codex_portal") "/data/codex/bin/codex_portal" "755"
Upload-Bytes (Join-Path $Payload "bin\codex_webui") "/data/codex/bin/codex_webui" "755"
Upload-Bytes (Join-Path $Payload "scripts\dropbear") "/usr/sbin/dropbear" "755"
Upload-Bytes (Join-Path $Payload "scripts\dropbearkey") "/usr/sbin/dropbearkey" "755"

Step "Uploading runtime files"
Upload-Bytes (Join-Path $Payload "scripts\init.sh") "/data/codex/init.sh" "755"
Upload-Bytes (Join-Path $Payload "scripts\offline_egress_guard.sh") "/data/codex/offline_egress_guard.sh" "755"
Upload-Bytes (Join-Path $Payload "scripts\recovery_ap.sh") "/data/codex/recovery_ap.sh" "755"
Upload-Bytes (Join-Path $Payload "scripts\rcS.local") "/etc/init.d/rcS.local" "755"
if (-not $SkipCloudSuppression) {
    Upload-Bytes (Join-Path $Payload "scripts\netservicestarter.lua") "/opt/luaworks/tasks/connectserver/netservicestarter.lua" "644"
} else {
    Info "skipped netservicestarter.lua cloud-suppression patch"
}
Upload-Bytes (Join-Path $Payload "activity\codexactivity.lua") "/pkg/codexactivity/codexactivity.lua" "644"
Upload-Bytes (Join-Path $Payload "mqtt\codexmqtt.lua") "/pkg/codexmqtt/codexmqtt.lua" "644"

Step "Uploading configuration"
Upload-Text "$HubId`n" "/data/codex/hub_id" "644"
if ($SkipCloudSuppression) {
    Upload-Text "0`n" "/data/codex/cloud_blocker.conf" "644"
} else {
    Upload-Text "1`n" "/data/codex/cloud_blocker.conf" "644"
}
Upload-Text "1`n" "/etc/tdeenable" "644"
Upload-Text "{""plugin"":""codexactivity""}`n" "/pkg/codexactivity/manifest.json" "644"
Upload-Text "{""plugin"":""codexmqtt""}`n" "/pkg/codexmqtt/manifest.json" "644"
Upload-Text (Build-MqttConfig) "/data/codexmqtt/config.json" "600"

Step "Post-install permissions and startup"
$post = "mkdir -p /data/codex/bin /etc/dropbear /home/root/.ssh /data/codexmqtt /pkg/codexactivity /pkg/codexmqtt; " +
        "ln -sf dropbearmulti /data/codex/bin/dropbear; " +
        "ln -sf dropbearmulti /data/codex/bin/dropbearkey; " +
        "chmod 755 /data/codex/bin/dropbearmulti /data/codex/bin/codex_dhcpd /data/codex/bin/codex_hbus /data/codex/bin/codex_hal_ltcp /data/codex/bin/codex_bthid_keyboard /data/codex/bin/codex_portal /data/codex/bin/codex_webui /data/codex/init.sh /data/codex/offline_egress_guard.sh /data/codex/recovery_ap.sh /usr/sbin/dropbear /usr/sbin/dropbearkey /etc/init.d/rcS.local; " +
        "chmod 600 /data/codexmqtt/config.json 2>/dev/null || true; " +
        "/bin/busybox sync 2>/dev/null || true"
Invoke-Remote $post $null 60000 | Out-Null

$start = "killall codex_webui 2>/dev/null || true; killall codex_bthid_keyboard 2>/dev/null || true; " +
         "/data/codex/offline_egress_guard.sh monitor >> /cache/codex-init.log 2>&1 & " +
         "if ! ps | grep '[d]ropbear' >/dev/null 2>&1; then /usr/sbin/dropbear -R -p 22; fi; " +
         "mkdir -p /cache/bin; ln -sf /data/codex/bin/codex_bthid_keyboard /cache/bin/bthid_keyboard; " +
         "/data/codex/bin/codex_webui 8080 >> /cache/codex-init.log 2>&1 & " +
         "/data/codex/bin/codex_bthid_keyboard >> /cache/codex-init.log 2>&1 & " +
         "sleep 1; " +
         "/data/codex/bin/codex_hbus $(Remote-Quote $HubId) harmony.automation?discover '{""gatewayType"":""codexactivity""}' >> /cache/codex-init.log 2>&1 || true; " +
         "/data/codex/bin/codex_hbus $(Remote-Quote $HubId) harmony.automation?discover '{""gatewayType"":""codexmqtt""}' >> /cache/codex-init.log 2>&1 || true; " +
         "ps | grep '[c]odex_webui' || true; ps | grep '[c]odex_bthid_keyboard' || true; ps | grep '[d]ropbear' || true"
$running = Invoke-Remote $start $null 90000
Write-Host $running.Trim()

Step "Verifying binary checksums"
$expected = [ordered]@{
    "/data/codex/bin/dropbearmulti" = (Get-FileHash -Algorithm MD5 -LiteralPath (Join-Path $Payload "bin\dropbearmulti")).Hash.ToLowerInvariant()
    "/data/codex/bin/codex_dhcpd" = (Get-FileHash -Algorithm MD5 -LiteralPath (Join-Path $Payload "bin\codex_dhcpd")).Hash.ToLowerInvariant()
    "/data/codex/bin/codex_hbus" = (Get-FileHash -Algorithm MD5 -LiteralPath (Join-Path $Payload "bin\codex_hbus")).Hash.ToLowerInvariant()
    "/data/codex/bin/codex_hal_ltcp" = (Get-FileHash -Algorithm MD5 -LiteralPath (Join-Path $Payload "bin\codex_hal_ltcp")).Hash.ToLowerInvariant()
    "/data/codex/bin/codex_bthid_keyboard" = (Get-FileHash -Algorithm MD5 -LiteralPath (Join-Path $Payload "bin\codex_bthid_keyboard")).Hash.ToLowerInvariant()
    "/data/codex/bin/codex_portal" = (Get-FileHash -Algorithm MD5 -LiteralPath (Join-Path $Payload "bin\codex_portal")).Hash.ToLowerInvariant()
    "/data/codex/bin/codex_webui" = (Get-FileHash -Algorithm MD5 -LiteralPath (Join-Path $Payload "bin\codex_webui")).Hash.ToLowerInvariant()
}
$paths = ($expected.Keys | ForEach-Object { Remote-Quote $_ }) -join " "
$verify = Invoke-Remote "md5sum $paths" $null 45000
Write-Host $verify.Trim()
foreach ($line in ($verify -split "`n")) {
    $parts = $line.Trim() -split "\s+"
    if ($parts.Count -ge 2 -and $expected.Contains($parts[1]) -and $expected[$parts[1]] -ne $parts[0]) {
        throw "checksum mismatch for $($parts[1]): expected $($expected[$parts[1]]) got $($parts[0])"
    }
}

if (-not $SkipCloudSuppression -and -not $NoApplyCloudRestart) {
    Step "Applying cloud blocker"
    Info "Rebooting the hub so Logitech cloud services restart in blocked mode."
    Invoke-Remote "(/bin/sleep 2; /sbin/reboot || reboot) >/dev/null 2>&1 & echo rebooting" $null 30000 | Out-Null
    Start-Sleep -Seconds 8
    Wait-TcpPort $HubHost $Port 180 "SSH"
    Wait-TcpPort $HubHost 8080 180 "Web UI"
}

Step "Done"
Info "Web UI: http://$HubHost`:8080/"
Info "Web UI authentication: disabled"
Info "Backup directory on hub: $backupDir"
if (-not $SkipCloudSuppression) {
    Info "Cloud blocker: enabled and applied"
}
Info "If IR commands do not work, update /data/codex/hub_id with the correct hub id and restart codex_webui."
