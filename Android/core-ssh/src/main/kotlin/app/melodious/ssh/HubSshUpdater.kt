package app.melodious.ssh

import app.melodious.protocol.update.HubSoftware
import app.melodious.protocol.update.LatestRelease
import app.melodious.protocol.update.ReleaseDownloader
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.zip.ZipInputStream

class HubUpdateException(message: String) : IOException(message)

data class HubUpdateResult(
    val ok: Boolean,
    val message: String,
    val alreadyCurrent: Boolean = false,
    val rebooted: Boolean = false,
    val version: String? = null,
)

/** Where one hub payload file goes, as install_webui.py installs it. */
data class HubFile(val dest: String, val mode: String, val reboot: Boolean)

/** Remembers each hub's SSH host key on first use; a changed key stops the update. */
interface HostKeyStore {
    fun get(host: String): String?
    fun put(host: String, fingerprint: String)
}

/**
 * Updates the hub from the phone the way install_webui.py does: over SSH with the owner's hub key.
 * The release zip comes from GitHub and is checked against the release's SHA256SUMS.txt; the hub only
 * receives files from it. On the hub, `hub_update.sh` (bundled here, the same file the macOS app uses)
 * runs the installer's transaction from a RAM staging folder, so it finishes even if the phone drops
 * off Wi-Fi.
 */
class HubSshUpdater(
    private val downloader: ReleaseDownloader,
    private val hostKeys: HostKeyStore,
    private val pollMs: Long = 2000,
    private val rebootWaitMs: Long = 20_000,
) {
    companion object {
        /** Must match HUB_FILES in tools/releases/release.py and the macOS app (checked by a test). */
        val HUB_FILES: Map<String, HubFile> = linkedMapOf(
            "payload/bin/codex_webui" to HubFile("/data/codex/bin/codex_webui", "755", reboot = false),
            "payload/bin/codex_hbus" to HubFile("/data/codex/bin/codex_hbus", "755", reboot = false),
            "payload/bin/codex_hal_ltcp" to HubFile("/data/codex/bin/codex_hal_ltcp", "755", reboot = false),
            "payload/bin/codex_bthid_keyboard" to HubFile("/data/codex/bin/codex_bthid_keyboard", "755", reboot = false),
            "payload/bin/codex_bt_pair_agent" to HubFile("/data/codex/bin/codex_bt_pair_agent", "755", reboot = false),
            "payload/activity/codexactivity.lua" to HubFile("/pkg/codexactivity/codexactivity.lua", "644", reboot = true),
            "payload/mqtt/codexmqtt.lua" to HubFile("/pkg/codexmqtt/codexmqtt.lua", "644", reboot = true),
            "payload/bin/codex_portal" to HubFile("/data/codex/bin/codex_portal", "755", reboot = false),
            "payload/bin/codex_dhcpd" to HubFile("/data/codex/bin/codex_dhcpd", "755", reboot = false),
            "payload/bin/dropbearmulti" to HubFile("/data/codex/bin/dropbearmulti", "755", reboot = false),
            "payload/scripts/dropbear" to HubFile("/usr/sbin/dropbear", "755", reboot = false),
            "payload/scripts/dropbearkey" to HubFile("/usr/sbin/dropbearkey", "755", reboot = false),
            "payload/scripts/init.sh" to HubFile("/data/codex/init.sh", "755", reboot = true),
            "payload/scripts/offline_egress_guard.sh" to HubFile("/data/codex/offline_egress_guard.sh", "755", reboot = true),
            "payload/scripts/recovery_ap.sh" to HubFile("/data/codex/recovery_ap.sh", "755", reboot = true),
            "payload/scripts/rcS.local" to HubFile("/etc/init.d/rcS.local", "755", reboot = true),
            "payload/scripts/netservicestarter.lua" to HubFile("/opt/luaworks/tasks/connectserver/netservicestarter.lua", "644", reboot = true),
        )
        private val INVENTORY = setOf("payload/bin/MANIFEST.txt", "payload/bin/FILES")

        fun script(): ByteArray = HubSshUpdater::class.java.getResourceAsStream("/hub_update.sh")?.use { it.readBytes() }
            ?: error("hub_update.sh missing from the app")

        private fun md5(bytes: ByteArray) = MessageDigest.getInstance("MD5").digest(bytes).joinToString("") { "%02x".format(it) }

        data class PayloadFile(val rel: String, val file: HubFile, val body: ByteArray, val md5: String) {
            val name get() = rel.replace('/', '_')
        }

        /** Every mapped payload file from the hub zip, checked against its MANIFEST.txt. */
        fun readPayload(zip: File, version: String): List<PayloadFile> {
            val top = "melodious-hub-$version/"
            val contents = LinkedHashMap<String, ByteArray>()
            ZipInputStream(zip.inputStream().buffered()).use { zin ->
                while (true) {
                    val entry = zin.nextEntry ?: break
                    if (entry.isDirectory || !entry.name.startsWith(top)) continue
                    val rel = entry.name.removePrefix(top)
                    if (rel.startsWith("payload/")) contents[rel] = zin.readBytes()
                }
            }
            for (rel in contents.keys) {
                if (rel !in HUB_FILES && rel !in INVENTORY) {
                    throw HubUpdateException("The hub zip has $rel, which this app doesn't know how to install. Update this app first.")
                }
            }
            val missing = HUB_FILES.keys.filter { it !in contents }
            if (missing.isNotEmpty()) throw HubUpdateException("The hub zip is missing ${missing.joinToString()}.")
            contents["payload/bin/MANIFEST.txt"]?.toString(Charsets.UTF_8)?.lineSequence()?.forEach { line ->
                val m = Regex("""^([0-9a-f]{32})\s+(\S+)$""").matchEntire(line) ?: return@forEach
                val body = contents["payload/bin/${m.groupValues[2]}"]
                if (body == null || md5(body) != m.groupValues[1]) {
                    throw HubUpdateException("The hub zip's MANIFEST.txt doesn't match ${m.groupValues[2]}.")
                }
            }
            return HUB_FILES.map { (rel, file) -> PayloadFile(rel, file, contents.getValue(rel), md5(contents.getValue(rel))) }
        }
    }

    suspend fun update(
        release: LatestRelease,
        host: String,
        privateKeyPem: String,
        workDir: File,
        sshPort: Int = 22,
        onStep: (String) -> Unit = {},
        versionProbe: suspend () -> HubSoftware?,
    ): HubUpdateResult = withContext(Dispatchers.IO) {
        val zipName = "melodious-hub-${release.version}.zip"
        onStep("Downloading the hub software from GitHub…")
        val zip = downloader.fetchVerified(release, zipName, workDir)
        val files = try { readPayload(zip, release.version) } finally { zip.delete() }

        onStep("Connecting to the hub…")
        val session = connect(host, sshPort, privateKeyPem)
        try {
            val stage = exec(session, "S=/var/volatile/codex-update-\$(date +%s); mkdir -p /var/volatile && mkdir \"\$S\" && chmod 700 \"\$S\" && mkdir \"\$S/files\" && echo \"\$S\"").trim()
            if (!Regex("""^/var/volatile/codex-update-\d+$""").matches(stage)) throw HubUpdateException("Unexpected staging folder: $stage")
            exec(session, "cat > $stage/hub_update.sh", script())
            val status = exec(session, "sh $stage/hub_update.sh status ${files.joinToString(" ") { it.file.dest }}")
            if (!Regex("""^hub_id yes$""", RegexOption.MULTILINE).containsMatchIn(status)) {
                runCatching { exec(session, "rm -rf $stage") }
                throw HubUpdateException("This hub has no Melodious setup yet. Install it once with the installer.")
            }
            val current = Regex("""^file (\S+) (\S+)$""", RegexOption.MULTILINE).findAll(status)
                .associate { it.groupValues[2] to it.groupValues[1] }
            // codex_webui goes last, as with the installer.
            val changed = files.filter { current[it.file.dest] != it.md5 }
                .sortedBy { if (it.file.dest.endsWith("/codex_webui")) 1 else 0 }
            if (changed.isEmpty()) {
                runCatching { exec(session, "rm -rf $stage") }
                return@withContext HubUpdateResult(true, "The hub already has Melodious ${release.version}'s software.", alreadyCurrent = true)
            }

            onStep("Sending ${changed.size} file${if (changed.size == 1) "" else "s"} to the hub…")
            for (f in changed) exec(session, "cat > $stage/files/${f.name}", f.body)
            val plan = changed.joinToString("") { "${it.md5} ${it.file.mode} ${if (it.file.reboot) 1 else 0} ${it.name} ${it.file.dest}\n" }
            exec(session, "cat > $stage/plan", plan.toByteArray())

            onStep("Installing on the hub…")
            exec(session, "sh -c \"trap '' HUP; sh $stage/hub_update.sh apply $stage\" </dev/null >/dev/null 2>&1 &")
            session.disconnect()

            var result: Pair<String, String>? = null
            val deadline = System.currentTimeMillis() + 6 * 60 * 1000
            while (result == null && System.currentTimeMillis() < deadline) {
                delay(pollMs)
                val log = runCatching {
                    val s = connect(host, sshPort, privateKeyPem)
                    try { exec(s, "cat $stage/log 2>/dev/null || true") } finally { s.disconnect() }
                }.getOrNull() ?: continue // the hub keeps going on its own; try again
                if (log.lineSequence().any { it == "STEP restarting" }) onStep("Restarting the hub's services…")
                Regex("""^RESULT (\S+) ?(.*)$""", RegexOption.MULTILINE).find(log)?.let { result = it.groupValues[1] to it.groupValues[2] }
            }
            val (code, text) = result ?: throw HubUpdateException("The hub didn't finish the update in 6 minutes. Check it with the installer.")
            if (code != "ok") throw HubUpdateException(text.ifEmpty { "The hub update ended with $code." })

            val rebooted = text == "reboot"
            if (rebooted) {
                onStep("The hub is restarting…")
                delay(rebootWaitMs)
            } else {
                runCatching {
                    val s = connect(host, sshPort, privateKeyPem)
                    try { exec(s, "rm -rf $stage") } finally { s.disconnect() }
                }
            }
            onStep("Waiting for the hub…")
            val until = System.currentTimeMillis() + if (rebooted) 4 * 60 * 1000 else 60 * 1000
            var software: HubSoftware? = null
            while (software == null && System.currentTimeMillis() < until) {
                software = runCatching { versionProbe() }.getOrNull()
                if (software == null) delay(pollMs)
            }
            val runs = when (val s = software) {
                null -> return@withContext HubUpdateResult(false, "The update was installed, but the hub hasn't answered since. Give it a minute, then check it.", rebooted = rebooted)
                is HubSoftware.Known -> s.version
                HubSoftware.Legacy -> "1.2 or older"
            }
            HubUpdateResult(
                ok = true,
                message = "The hub was updated${if (rebooted) " and restarted" else ""}. It reports Melodious $runs.",
                rebooted = rebooted,
                version = (software as? HubSoftware.Known)?.version,
            )
        } finally {
            session.disconnect()
        }
    }

    private fun connect(host: String, port: Int, privateKeyPem: String): Session {
        val jsch = JSch()
        try {
            jsch.addIdentity("harmony_owner_key", privateKeyPem.trim().toByteArray(Charsets.UTF_8), null, null)
        } catch (e: Exception) {
            throw HubUpdateException("That isn't a private key this app can use: ${e.message}")
        }
        val session = jsch.getSession("root", host, port)
        // The key is pinned on first use below, the way ssh's accept-new does it.
        session.setConfig("StrictHostKeyChecking", "no")
        session.timeout = 15_000
        try {
            session.connect(15_000)
        } catch (e: Exception) {
            val msg = e.message.orEmpty()
            throw HubUpdateException(
                if (msg.contains("Auth fail", ignoreCase = true)) "The hub refused the SSH key. Use the key the installer uses (harmony_owner_…)."
                else "Couldn't reach the hub over SSH (port $port)."
            )
        }
        val fingerprint = session.hostKey.getFingerPrint(jsch)
        val known = hostKeys.get(host)
        if (known == null) {
            hostKeys.put(host, fingerprint)
        } else if (known != fingerprint) {
            session.disconnect()
            throw HubUpdateException("The hub's SSH identity changed since the last connection; not updating.")
        }
        return session
    }

    private fun exec(session: Session, command: String, input: ByteArray? = null, timeoutMs: Long = 120_000): String {
        val channel = session.openChannel("exec") as ChannelExec
        channel.setCommand(command)
        val out = ByteArrayOutputStream()
        val err = ByteArrayOutputStream()
        channel.outputStream = out
        channel.setErrStream(err)
        // JSch sends EOF when this stream ends, so `cat > file` finishes.
        channel.setInputStream(input?.inputStream())
        channel.connect(15_000)
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!channel.isClosed) {
            if (System.currentTimeMillis() > deadline) {
                channel.disconnect()
                throw HubUpdateException("The hub stopped answering.")
            }
            Thread.sleep(50)
        }
        val code = channel.exitStatus
        channel.disconnect()
        if (code != 0) throw HubUpdateException(err.toString(Charsets.UTF_8).trim().ifEmpty { "Command on the hub failed ($code)." })
        return out.toString(Charsets.UTF_8)
    }
}
