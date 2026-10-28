package app.melodious.protocol.update

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.security.MessageDigest

class ReleaseDownloadsTest {
    private lateinit var server: HttpServer
    private lateinit var dir: File
    private val apk = ByteArray(300_000) { (it * 7).toByte() }
    private var sums = ""
    private val base get() = "http://127.0.0.1:${server.address.port}"

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Before
    fun start() {
        dir = Files.createTempDirectory("melodious-dl").toFile()
        sums = "${sha(apk)}  melodious-9.0.0.apk\n"
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        fun route(path: String, status: Int, body: ByteArray = ByteArray(0), location: String? = null) =
            server.createContext(path) { ex ->
                location?.let { ex.responseHeaders.add("Location", it) }
                ex.sendResponseHeaders(status, if (body.isEmpty()) -1 else body.size.toLong())
                if (body.isNotEmpty()) ex.responseBody.use { it.write(body) } else ex.close()
            }
        route("/assets/apk", 200, apk)
        route("/assets/sums", 200) // replaced below with the live text
        server.removeContext("/assets/sums")
        server.createContext("/assets/sums") { ex ->
            val b = sums.toByteArray()
            ex.sendResponseHeaders(200, b.size.toLong()); ex.responseBody.use { it.write(b) }
        }
        route("/dl/apk", 302, location = "/assets/apk")
        route("/dl/elsewhere", 302, location = "http://evil.invalid/apk")
        server.start()
    }

    @After
    fun stop() {
        server.stop(0)
        dir.deleteRecursively()
    }

    private fun release(apkPath: String = "/dl/apk") = LatestRelease(
        version = "9.0.0", tag = "v9.0.0", url = "$base/release",
        assets = mapOf("melodious-9.0.0.apk" to "$base$apkPath", "SHA256SUMS.txt" to "$base/assets/sums"),
    )

    private fun downloader() = ReleaseDownloader(isAllowed = { it.startsWith(base) })

    @Test
    fun followsAllowedRedirectsAndChecksTheSum() = runBlocking {
        var last = 0L
        val file = downloader().fetchVerified(release(), "melodious-9.0.0.apk", dir) { done, _ -> last = done }
        assertArrayEquals(apk, file.readBytes())
        assertEquals(apk.size.toLong(), last)
        assertFalse(File(dir, "melodious-9.0.0.apk.part").exists())
    }

    @Test
    fun refusesARedirectOffTheAllowedHosts() {
        val err = assertThrows(UpdateDownloadException::class.java) {
            runBlocking { downloader().fetchVerified(release("/dl/elsewhere"), "melodious-9.0.0.apk", dir) }
        }
        assertTrue(err.message!!.contains("refusing"))
    }

    @Test
    fun refusesAFileThatDoesNotMatchTheSum() {
        sums = "${"0".repeat(64)}  melodious-9.0.0.apk\n"
        val err = assertThrows(UpdateDownloadException::class.java) {
            runBlocking { downloader().fetchVerified(release(), "melodious-9.0.0.apk", dir) }
        }
        assertTrue(err.message!!.contains("doesn't match"))
        assertFalse(File(dir, "melodious-9.0.0.apk").exists())
        assertFalse(File(dir, "melodious-9.0.0.apk.part").exists())
    }

    @Test
    fun refusesAnAssetMissingFromTheSums() {
        sums = "${sha(apk)}  something-else.apk\n"
        assertThrows(UpdateDownloadException::class.java) {
            runBlocking { downloader().fetchVerified(release(), "melodious-9.0.0.apk", dir) }
        }
    }

    @Test
    fun theDefaultAllowListRejectsNonGitHubStarts() {
        val err = assertThrows(UpdateDownloadException::class.java) {
            runBlocking { ReleaseDownloader().fetchVerified(release(), "melodious-9.0.0.apk", dir) }
        }
        assertTrue(err.message!!.startsWith("Refusing to download from outside GitHub"))
    }

    @Test
    fun parsesSums() {
        val parsed = ReleaseDownloader.parseSums("${"a".repeat(64)}  x.apk\n${"B".repeat(64)} *y.zip\nnoise\n")
        assertEquals(mapOf("x.apk" to "a".repeat(64), "y.zip" to "b".repeat(64)), parsed)
    }

    @Test
    fun latestKeepsOnlyGitHubAssetLinks() {
        val list = GitHubReleases.parse(
            """[{"tag_name":"v1.3.0","draft":false,"prerelease":false,
            "html_url":"https://github.com/schlambos/harmony-hub-control/releases/tag/v1.3.0",
            "assets":[{"name":"melodious-1.3.0.apk","browser_download_url":"https://github.com/schlambos/harmony-hub-control/releases/download/v1.3.0/melodious-1.3.0.apk"},
                      {"name":"SHA256SUMS.txt","browser_download_url":"https://evil.example/SHA256SUMS.txt"}]}]"""
        )!!
        val latest = GitHubReleases.latestAndroid(list)!!
        assertEquals(setOf("melodious-1.3.0.apk"), latest.assets.keys)
    }
}
