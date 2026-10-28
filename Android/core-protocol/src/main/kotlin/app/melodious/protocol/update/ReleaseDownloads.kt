package app.melodious.protocol.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

class UpdateDownloadException(message: String) : IOException(message)

/**
 * Downloads release assets so that every byte comes from the owner's GitHub: redirects are followed
 * by hand and each hop must pass [isAllowed] (GitHub's hosts by default), and the file must match the
 * `SHA256SUMS.txt` published in the same release.
 */
class ReleaseDownloader(
    baseClient: OkHttpClient = OkHttpClient(),
    private val isAllowed: (String) -> Boolean = GitHubReleases::isGitHubUrl,
    private val userAgent: String = "Melodious",
) {
    private val http = baseClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    /** Downloads [assetName] from [release] into [dir], checked against the release's SHA256SUMS.txt. */
    suspend fun fetchVerified(
        release: LatestRelease,
        assetName: String,
        dir: File,
        onProgress: (done: Long, total: Long) -> Unit = { _, _ -> },
    ): File = withContext(Dispatchers.IO) {
        val sumsUrl = release.assets[SUMS_NAME]
            ?: throw UpdateDownloadException("Release ${release.version} has no $SUMS_NAME, so the download can't be checked.")
        val assetUrl = release.assets[assetName]
            ?: throw UpdateDownloadException("Release ${release.version} has no $assetName.")
        val sums = parseSums(String(fetchBytes(sumsUrl, MAX_SUMS_BYTES), Charsets.UTF_8))
        val expected = sums[assetName]
            ?: throw UpdateDownloadException("$SUMS_NAME in release ${release.version} doesn't list $assetName.")
        dir.mkdirs()
        val target = File(dir, assetName)
        val partial = File(dir, "$assetName.part")
        val actual = download(assetUrl, partial, onProgress)
        if (actual != expected) {
            partial.delete()
            throw UpdateDownloadException("The download doesn't match the checksum GitHub published for it. Nothing was installed.")
        }
        target.delete()
        if (!partial.renameTo(target)) throw UpdateDownloadException("Couldn't save the download.")
        target
    }

    /** Small text files (the checksum list). */
    private suspend fun fetchBytes(url: String, max: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        open(url).use { response ->
            val body = response.body ?: throw UpdateDownloadException("GitHub sent an empty answer.")
            body.byteStream().use { input ->
                val buf = ByteArray(8192)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (out.size() + n > max) throw UpdateDownloadException("$SUMS_NAME is unexpectedly large.")
                    out.write(buf, 0, n)
                }
            }
        }
        return out.toByteArray()
    }

    /** Streams [url] to [file] and returns its SHA-256 hex. */
    private suspend fun download(url: String, file: File, onProgress: (Long, Long) -> Unit): String {
        val digest = MessageDigest.getInstance("SHA-256")
        open(url).use { response ->
            val body = response.body ?: throw UpdateDownloadException("GitHub sent an empty answer.")
            val total = body.contentLength()
            var done = 0L
            body.byteStream().use { input ->
                file.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        done += n
                        onProgress(done, total)
                    }
                }
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** GET with hand-followed redirects; every URL on the way must be allowed. */
    private fun open(start: String): okhttp3.Response {
        var url: HttpUrl = start.takeIf(isAllowed)?.toHttpUrlOrNull()
            ?: throw UpdateDownloadException("Refusing to download from outside GitHub: $start")
        repeat(MAX_REDIRECTS + 1) {
            val response = try {
                http.newCall(Request.Builder().url(url).header("User-Agent", userAgent).get().build()).execute()
            } catch (e: IOException) {
                throw UpdateDownloadException("Couldn't reach GitHub.")
            }
            if (response.isRedirect) {
                val next = response.header("Location")?.let { url.resolve(it) }
                response.close()
                if (next == null || !isAllowed(next.toString())) {
                    throw UpdateDownloadException("GitHub redirected the download somewhere else; refusing.")
                }
                url = next
                return@repeat
            }
            if (!response.isSuccessful) {
                val code = response.code
                response.close()
                throw UpdateDownloadException("GitHub answered $code for the download.")
            }
            return response
        }
        throw UpdateDownloadException("Too many redirects.")
    }

    companion object {
        const val SUMS_NAME = "SHA256SUMS.txt"
        private const val MAX_REDIRECTS = 5
        private const val MAX_SUMS_BYTES = 64 * 1024

        /** `<sha256>  <name>` lines; anything else is ignored. */
        fun parseSums(text: String): Map<String, String> =
            text.lineSequence().mapNotNull { line ->
                Regex("""^([0-9a-fA-F]{64}) [ *](\S+)$""").matchEntire(line.trimEnd())
                    ?.let { it.groupValues[2] to it.groupValues[1].lowercase() }
            }.toMap()
    }
}
