package app.melodious.ssh

import app.melodious.protocol.update.LatestRelease
import app.melodious.protocol.update.ReleaseDownloader
import app.melodious.protocol.update.HubSoftware
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class HubSshUpdaterTest {
    private fun md5(b: ByteArray) = MessageDigest.getInstance("MD5").digest(b).joinToString("") { "%02x".format(it) }

    private fun hubZip(dir: File, version: String, extra: Map<String, ByteArray> = emptyMap(), badManifest: Boolean = false): File {
        val files = HubSshUpdater.HUB_FILES.keys.associateWith { "$it $version\n".toByteArray() } + extra
        val manifest = files.filterKeys { it.startsWith("payload/bin/") }.entries
            .joinToString("") { (rel, body) -> "${if (badManifest) "0".repeat(32) else md5(body)}  ${rel.substringAfterLast('/')}\n" }
        val zip = File(dir, "melodious-hub-$version.zip")
        ZipOutputStream(zip.outputStream()).use { out ->
            for ((rel, body) in files + ("payload/bin/MANIFEST.txt" to manifest.toByteArray()) + ("install_webui.py" to "x".toByteArray())) {
                out.putNextEntry(ZipEntry("melodious-hub-$version/$rel")); out.write(body); out.closeEntry()
            }
        }
        return zip
    }

    @Test
    fun readsEveryMappedFileWithItsMd5() {
        val dir = Files.createTempDirectory("hubzip").toFile()
        try {
            val files = HubSshUpdater.readPayload(hubZip(dir, "9.0.0"), "9.0.0")
            assertEquals(HubSshUpdater.HUB_FILES.size, files.size)
            val webui = files.first { it.file.dest == "/data/codex/bin/codex_webui" }
            assertEquals(md5("payload/bin/codex_webui 9.0.0\n".toByteArray()), webui.md5)
            assertTrue(files.first { it.rel == "payload/activity/codexactivity.lua" }.file.reboot)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun refusesUnknownFilesAndAWrongManifest() {
        val dir = Files.createTempDirectory("hubzip").toFile()
        try {
            val unknown = hubZip(dir, "9.0.1", extra = mapOf("payload/bin/codex_new" to "x".toByteArray()))
            val e1 = assertThrows(HubUpdateException::class.java) { HubSshUpdater.readPayload(unknown, "9.0.1") }
            assertTrue(e1.message!!.contains("doesn't know how to install"))
            val bad = hubZip(dir, "9.0.2", badManifest = true)
            val e2 = assertThrows(HubUpdateException::class.java) { HubSshUpdater.readPayload(bad, "9.0.2") }
            assertTrue(e2.message!!.contains("MANIFEST.txt doesn't match"))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun bundlesTheHubScript() {
        assertTrue(String(HubSshUpdater.script()).contains("sh hub_update.sh apply <stage>"))
    }

    /** End to end against tools/hub-emu with Dropbear on 127.0.0.1:2222; off unless HUB_EMU_SSH is set. */
    @Test
    fun updatesHubEmuOverSsh() = runBlocking {
        assumeTrue(System.getenv("HUB_EMU_SSH") != null)
        val zip = File(System.getenv("HUB_ZIP"))
        val version = System.getenv("HUB_ZIP_VERSION")
        val body = zip.readBytes()
        val name = "melodious-hub-$version.zip"
        val sha = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/zip") { ex -> ex.sendResponseHeaders(200, body.size.toLong()); ex.responseBody.use { it.write(body) } }
            createContext("/sums") { ex -> val b = "$sha  $name\n".toByteArray(); ex.sendResponseHeaders(200, b.size.toLong()); ex.responseBody.use { it.write(b) } }
            start()
        }
        val base = "http://127.0.0.1:${server.address.port}"
        val keys = mutableMapOf<String, String>()
        val updater = HubSshUpdater(
            downloader = ReleaseDownloader(isAllowed = { it.startsWith(base) }),
            hostKeys = object : HostKeyStore {
                override fun get(host: String) = keys[host]
                override fun put(host: String, fingerprint: String) { keys[host] = fingerprint }
            },
            pollMs = 500,
            rebootWaitMs = 1000,
        )
        val release = LatestRelease(version, "v$version", "x", assets = mapOf(name to "$base/zip", "SHA256SUMS.txt" to "$base/sums"))
        val work = Files.createTempDirectory("hubwork").toFile()
        try {
            val steps = mutableListOf<String>()
            val result = updater.update(
                release, "127.0.0.1", File(System.getenv("HUB_EMU_KEY")).readText(), work, sshPort = 2222,
                onStep = { steps += it }, versionProbe = { HubSoftware.Known(version) },
            )
            println(steps.joinToString("\n") + "\n" + result)
            assertTrue(result.message, result.ok)
            assertTrue(keys.containsKey("127.0.0.1"))
            val again = updater.update(release, "127.0.0.1", File(System.getenv("HUB_EMU_KEY")).readText(), work, sshPort = 2222,
                versionProbe = { HubSoftware.Known(version) })
            assertTrue(again.message, again.alreadyCurrent)
            keys["127.0.0.1"] = "SHA256:not-this-hub"
            val changed = assertThrows(HubUpdateException::class.java) {
                runBlocking { updater.update(release, "127.0.0.1", File(System.getenv("HUB_EMU_KEY")).readText(), work, sshPort = 2222, versionProbe = { null }) }
            }
            assertTrue(changed.message!!.contains("identity changed"))
        } finally {
            server.stop(0)
            work.deleteRecursively()
        }
    }
}
