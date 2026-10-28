package app.melodious.protocol.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Update notices: ask GitHub for this project's releases and say when a newer app or hub release
 * exists. Nothing is downloaded or installed here.
 *
 * Trust is "it came from the owner's GitHub": HTTPS to this repository's release API only, and
 * release links only on github.com under this repository.
 */
object GitHubReleases {
    const val REPO = "schlambos/harmony-hub-control"
    const val RELEASES_URL = "https://api.github.com/repos/$REPO/releases?per_page=20"
    private const val RELEASE_PAGE_PREFIX = "https://github.com/$REPO/releases/"
    const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000

    /** Release downloads leave api.github.com for GitHub's own download hosts. */
    private val GITHUB_HOSTS = setOf(
        "api.github.com",
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
    )

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** True only for HTTPS URLs on GitHub's hosts; github.com and the API must also be in this repo. */
    fun isGitHubUrl(raw: String?): Boolean {
        val url = raw?.toHttpUrlOrNull() ?: return false
        if (url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty() || url.port != 443) return false
        if (url.host !in GITHUB_HOSTS) return false
        val path = url.encodedPath
        return when (url.host) {
            "github.com" -> path.startsWith("/$REPO/")
            "api.github.com" -> path.startsWith("/repos/$REPO/")
            else -> true
        }
    }

    fun parse(body: String): JsonArray? = runCatching { json.parseToJsonElement(body).jsonArray }.getOrNull()

    /**
     * Newest published `v<x.y.z>` release that carries [assetFor]'s asset on GitHub.
     * Drafts and prereleases never count.
     */
    fun latest(
        releases: JsonArray,
        allowUrl: (String) -> Boolean = ::isGitHubUrl,
        assetFor: (String) -> String,
    ): LatestRelease? {
        var best: LatestRelease? = null
        for (element in releases) {
            val rel = element as? JsonObject ?: continue
            if (rel.bool("draft") || rel.bool("prerelease")) continue
            val tag = rel.str("tag_name") ?: continue
            if (!tag.startsWith("v")) continue
            val version = tag.removePrefix("v")
            val parsed = ReleaseVersion.parse(version) ?: continue
            val wanted = assetFor(version)
            val assets = (rel["assets"] as? JsonArray).orEmpty().mapNotNull {
                val asset = it as? JsonObject ?: return@mapNotNull null
                val name = asset.str("name") ?: return@mapNotNull null
                val link = asset.str("browser_download_url")?.takeIf(allowUrl) ?: return@mapNotNull null
                name to link
            }.toMap()
            if (wanted !in assets) continue
            val url = rel.str("html_url") ?: continue
            if (!url.startsWith(RELEASE_PAGE_PREFIX) || !isGitHubUrl(url)) continue
            val current = best?.let { ReleaseVersion.parse(it.version) }
            if (current != null && parsed <= current) continue
            best = LatestRelease(version, tag, url, rel.str("published_at").orEmpty(), assets)
        }
        return best
    }

    fun latestAndroid(releases: JsonArray, allowUrl: (String) -> Boolean = ::isGitHubUrl): LatestRelease? =
        latest(releases, allowUrl) { "melodious-$it.apk" }

    fun latestHub(releases: JsonArray, allowUrl: (String) -> Boolean = ::isGitHubUrl): LatestRelease? =
        latest(releases, allowUrl) { "melodious-hub-$it.zip" }

    /** One line about the hub, or "" when there is nothing to say. */
    fun hubNote(hub: HubSoftware?, latestHub: LatestRelease?): String {
        if (hub == null || latestHub == null) return ""
        val latest = ReleaseVersion.parse(latestHub.version) ?: return ""
        return when (hub) {
            HubSoftware.Legacy ->
                "Your hub runs Melodious 1.2 or older. Hub ${latestHub.version} is out; update it with the installer from the release page."
            is HubSoftware.Known -> {
                val running = ReleaseVersion.parse(hub.version)
                if (running != null && latest > running)
                    "Your hub runs Melodious ${hub.version}. Hub ${latestHub.version} is out; update it with the installer from the release page."
                else ""
            }
        }
    }

    private fun JsonObject.str(key: String): String? = this[key]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
    private fun JsonObject.bool(key: String): Boolean = this[key]?.let { runCatching { it.jsonPrimitive.booleanOrNull }.getOrNull() } ?: false
}

data class ReleaseVersion(val major: Int, val minor: Int, val patch: Int) : Comparable<ReleaseVersion> {
    override fun compareTo(other: ReleaseVersion): Int =
        compareValuesBy(this, other, ReleaseVersion::major, ReleaseVersion::minor, ReleaseVersion::patch)

    override fun toString() = "$major.$minor.$patch"

    companion object {
        private val PATTERN = Regex("""^(\d+)\.(\d+)\.(\d+)$""")
        fun parse(value: String?): ReleaseVersion? {
            val m = PATTERN.matchEntire(value?.trim().orEmpty()) ?: return null
            return runCatching { ReleaseVersion(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt()) }.getOrNull()
        }
    }
}

@Serializable
data class LatestRelease(
    val version: String,
    val tag: String,
    val url: String,
    val publishedAt: String = "",
    /** Asset name to its GitHub download link (only links on GitHub are kept). */
    val assets: Map<String, String> = emptyMap(),
)

/** What the hub says about its own software (`GET /api/version`). */
sealed interface HubSoftware {
    data class Known(val version: String) : HubSoftware
    /** The hub answered 404: Melodious 1.2.x or older, which has no version route. */
    data object Legacy : HubSoftware
}

sealed interface ReleaseFetch {
    data class Fresh(val releases: JsonArray, val etag: String) : ReleaseFetch
    data object NotModified : ReleaseFetch
    data class RateLimited(val untilMillis: Long) : ReleaseFetch
    data class Failed(val message: String) : ReleaseFetch
}

/** One GET of the release list. Redirects are refused, so the answer comes from api.github.com. */
class GitHubReleaseClient(
    baseClient: OkHttpClient = OkHttpClient(),
    private val releasesUrl: String = GitHubReleases.RELEASES_URL,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val http = baseClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    suspend fun fetch(etag: String?, userAgent: String): ReleaseFetch = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(releasesUrl)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", userAgent)
            .apply { if (!etag.isNullOrBlank()) header("If-None-Match", etag) }
            .get()
            .build()
        try {
            http.newCall(request).execute().use { response ->
                when (response.code) {
                    304 -> ReleaseFetch.NotModified
                    403, 429 -> {
                        val reset = response.header("x-ratelimit-reset")?.toLongOrNull()?.times(1000)
                        val retry = response.header("retry-after")?.toLongOrNull()?.times(1000)
                        ReleaseFetch.RateLimited(reset ?: (now() + (retry ?: 60L * 60 * 1000)))
                    }
                    200 -> {
                        val releases = GitHubReleases.parse(response.body?.string().orEmpty())
                            ?: return@use ReleaseFetch.Failed("GitHub sent something that isn't a release list.")
                        ReleaseFetch.Fresh(releases, response.header("etag").orEmpty())
                    }
                    else -> ReleaseFetch.Failed("GitHub answered ${response.code}.")
                }
            }
        } catch (e: IOException) {
            ReleaseFetch.Failed("Couldn't reach GitHub.")
        }
    }
}

private fun JsonArray?.orEmpty(): JsonArray = this ?: JsonArray(emptyList())
