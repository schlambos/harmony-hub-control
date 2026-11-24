param(
    [Alias("Host")]
    [string]$HubHost,
    [string]$KeyPath,
    [int]$Port = 22,
    [string]$SshUser = "root",
    [string]$BackupDir,
    [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"

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

function Quote-ProcessArg([string]$Arg) {
    if ($null -eq $Arg) { return '""' }
    if ($Arg.Length -eq 0) { return '""' }
    if ($Arg -notmatch '[\s"]') { return $Arg }
    $out = '"'
    $slashes = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq '\') { $slashes += 1; continue }
        if ($ch -eq '"') {
            $out += ('\' * (($slashes * 2) + 1)) + '"'
            $slashes = 0
            continue
        }
        if ($slashes) { $out += ('\' * $slashes); $slashes = 0 }
        $out += $ch
    }
    if ($slashes) { $out += ('\' * ($slashes * 2)) }
    return $out + '"'
}

function Remote-Quote([string]$Value) {
    return "'" + ($Value -replace "'", "'`"`"'`"'") + "'"
}

function Get-SshArgs() {
    return @(
        "-p", [string]$Port,
        "-i", $KeyPath,
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "$SshUser@$HubHost"
    )
}

# Same guard as install_webui.ps1 (#257): on a UTF-8 console, .NET
# Framework's stdin StreamWriter prepends EF BB BF to the child's stdin.
function Set-BomlessStdinEncoding() {
    try {
        $current = [Console]::InputEncoding
        if ($current.GetPreamble().Length -eq 0) { return $null }
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
        return $current
    } catch { return $null }
}

function Invoke-Remote([string]$Command, [int]$TimeoutMs = 90000) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "ssh"
    $allArgs = (Get-SshArgs) + @($Command)
    $psi.Arguments = ($allArgs | ForEach-Object { Quote-ProcessArg $_ }) -join " "
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $restoreInputEncoding = Set-BomlessStdinEncoding
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.StandardInput.Close()
    } finally {
        if ($null -ne $restoreInputEncoding) {
            try { [Console]::InputEncoding = $restoreInputEncoding } catch {}
        }
    }
    if (-not $p.WaitForExit($TimeoutMs)) {
        try { $p.Kill() } catch {}
        throw "ssh timed out while running: $Command"
    }
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    if ($p.ExitCode -ne 0) {
        throw "ssh failed with exit $($p.ExitCode)`ncommand=$Command`nstdout=$stdout`nstderr=$stderr"
    }
    if ($stderr.Trim()) { Write-Host $stderr.Trim() -ForegroundColor DarkGray }
    return $stdout
}

$HubHost = Prompt-IfMissing $HubHost "Harmony hub IP address" -Required
$KeyPath = Prompt-IfMissing $KeyPath "SSH private key path for root login" -Required
$KeyPath = (Resolve-Path -LiteralPath $KeyPath).Path

if (-not $BackupDir) {
    $BackupDir = (Invoke-Remote "ls -dt /data/codex-backups/webui-handoff-* 2>/dev/null | head -n 1 || true" 30000).Trim()
}
if (-not $BackupDir) {
    throw "No /data/codex-backups/webui-handoff-* backup was found. Pass -BackupDir if you know the path."
}

Write-Host "Restoring from $BackupDir" -ForegroundColor Cyan

$restore = @"
B=$(Remote-Quote $BackupDir)
killall codex_webui 2>/dev/null || true
killall codex_portal 2>/dev/null || true
killall codex_dhcpd 2>/dev/null || true
restore_one() {
  backup="$B/`$1"
  target="`$2"
  if [ -e "`$backup" ]; then
    cp -p "`$backup" "`$target"
    echo "restored `$target"
  else
    echo "missing backup for `$target"
  fi
}
restore_one _etc_init.d_rcS.local /etc/init.d/rcS.local
restore_one _opt_luaworks_tasks_connectserver_netservicestarter.lua /opt/luaworks/tasks/connectserver/netservicestarter.lua
restore_one _usr_sbin_dropbear /usr/sbin/dropbear
restore_one _usr_sbin_dropbearkey /usr/sbin/dropbearkey
restore_one _data_codex_hub_id /data/codex/hub_id
restore_one _data_codexmqtt_config.json /data/codexmqtt/config.json
chmod 755 /etc/init.d/rcS.local /usr/sbin/dropbear /usr/sbin/dropbearkey 2>/dev/null || true
chmod 600 /data/codexmqtt/config.json 2>/dev/null || true
/bin/busybox sync 2>/dev/null || true
echo "restore done; reboot the hub for boot-script changes to fully apply"
"@

$out = Invoke-Remote $restore 60000
Write-Host $out.Trim()
