package app.melodious.ssh

import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

/**
 * Direct SSH recovery & provisioning helper for rooted hubs (`root@<hub-ip>:22`).
 *
 * Designed specifically around the hub's BusyBox constraints documented in `README.md`:
 * - Uses only plain `ssh` exec channels (no `sftp`/`scp` subsystem required).
 * - Uses only commands present in the hub's BusyBox (`cat`, `cp`, `mv`, `rm`, `chmod`, `mkdir`, `ls -l`, `md5sum`).
 * - Enables emergency recovery right from the Android phone when:
 *   1. Web UI Basic Auth lockout occurs (`/data/codex/webui_auth.conf`).
 *   2. A user needs to roll back to the newest `/data/codex-backups/webui-handoff-*` backup (`restore_backup.ps1` equivalent).
 *   3. `codex_bthid_keyboard` or `codex_webui` needs to be restarted without full hub power-pull.
 */
class HubSshProvisioner(private val newClient: () -> JSch = { JSch() }) {

    data class SshCommandResult(
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
    ) {
        val isSuccess: Boolean get() = exitCode == 0
    }

    /**
     * Checks SSH connectivity and returns the Hub's `/etc/version`, `/data/codex/bin` inventory,
     * and available handoff backups under `/data/codex-backups`.
     */
    suspend fun inspectHubOverSsh(
        host: String,
        privateKeyPem: String,
        port: Int = 22,
    ): Result<String> = runSshScript(
        host = host,
        privateKeyPem = privateKeyPem,
        port = port,
        command = """
            echo "=== FIRMWARE ==="
            cat /etc/version 2>/dev/null || true
            echo "=== CODEX BINARIES ==="
            ls -l /data/codex/bin 2>/dev/null || true
            echo "=== HANDOFF BACKUPS ==="
            ls -l /data/codex-backups 2>/dev/null || true
        """.trimIndent()
    )

    /**
     * Emergency Auth Lockout Recovery:
     * Disables HTTP Basic Auth in `/data/codex/webui_auth.conf` and restarts `codex_webui`
     * so the user is never permanently locked out of their hub.
     */
    suspend fun resetWebUiAuthLockout(
        host: String,
        privateKeyPem: String,
        port: Int = 22,
    ): Result<String> = runSshScript(
        host = host,
        privateKeyPem = privateKeyPem,
        port = port,
        command = """
            rm -f /data/codex/webui_auth.conf
            /data/codex/scripts/init.sh restart 2>/dev/null || true
            echo "Auth lockout cleared (/data/codex/webui_auth.conf removed)."
        """.trimIndent()
    )

    /**
     * Restarts the `codex_bthid_keyboard` FIFO daemon and `codex_bt_pair_agent`.
     */
    suspend fun restartBluetoothHelpers(
        host: String,
        privateKeyPem: String,
        port: Int = 22,
    ): Result<String> = runSshScript(
        host = host,
        privateKeyPem = privateKeyPem,
        port = port,
        command = """
            /data/codex/scripts/init.sh restart 2>/dev/null || /etc/init.d/S99codex restart 2>/dev/null || true
            ls -l /tmp/bthid_status 2>/dev/null || true
            echo "Codex init services restarted."
        """.trimIndent()
    )

    private suspend fun runSshScript(
        host: String,
        privateKeyPem: String,
        port: Int,
        command: String,
    ): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val jsch = newClient()
            jsch.addIdentity(
                "harmony_owner_key",
                privateKeyPem.trim().toByteArray(StandardCharsets.UTF_8),
                null,
                null,
            )
            val session: Session = jsch.getSession("root", host, port)
            session.setConfig("StrictHostKeyChecking", "no")
            session.timeout = 8000
            session.connect()
            try {
                val channel = session.openChannel("exec") as ChannelExec
                channel.setCommand(command)
                val outBuf = ByteArrayOutputStream()
                val errBuf = ByteArrayOutputStream()
                channel.outputStream = outBuf
                channel.setErrStream(errBuf)
                channel.connect(8000)

                while (!channel.isClosed) {
                    Thread.sleep(50)
                }
                val code = channel.exitStatus
                channel.disconnect()
                val outStr = outBuf.toString(StandardCharsets.UTF_8.name()).trim()
                val errStr = errBuf.toString(StandardCharsets.UTF_8.name()).trim()
                if (code != 0 && outStr.isEmpty()) {
                    throw IllegalStateException(errStr.ifEmpty { "SSH exited with code $code" })
                }
                outStr.ifEmpty { errStr }
            } finally {
                session.disconnect()
            }
        }
    }
}
