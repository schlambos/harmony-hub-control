package app.melodious.protocol.catalog

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

const val DISCOVERY_URL =
    "https://cf-svcs.myharmony.com/Discovery/Discovery.svc/json/GetJsonOperations"
const val HARMONY_SIGNIN_URL =
    "https://lb-svcs.myharmony.com/CompositeSecurityServices/Security.svc/json2/signin"
const val SEARCH_DEVICE_BASE_URL =
    "https://svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json2/SearchDevice"

private const val DEVICE_MANAGER_BASE =
    "https://lb-svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/"
private val PROTOCOL_LIST_URL_RE = Regex(
    "^https://lb-svcs\\.myharmony\\.com/UserAccountDirectorPlatform/UserAccountDirector\\.svc/json2/Account/[A-Za-z0-9._-]+/ProtocolList$"
)
private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

data class CatalogHttpResponse(val status: Int, val payload: JsonElement?)

interface CatalogHttp {
    suspend fun get(url: String): CatalogHttpResponse
    suspend fun get(
        url: String,
        bearer: String?,
        extraHeaders: Map<String, String> = emptyMap(),
        authenticated: Boolean = false,
    ): CatalogHttpResponse = get(url)
    suspend fun postJson(
        url: String,
        payload: JsonElement,
        bearer: String? = null,
        extraHeaders: Map<String, String> = emptyMap(),
    ): CatalogHttpResponse

    suspend fun postForm(url: String, fields: Map<String, String>): CatalogHttpResponse
    fun clearCookies()
}

/**
 * OkHttp transport for Logitech's catalog endpoints, ported from the desktop
 * app's JsonClient: an exact endpoint allowlist, no redirects, and an
 * in-memory myharmony.com cookie jar that is never sent on a GET.
 */
class OkHttpCatalogHttp(
    baseClient: OkHttpClient = OkHttpClient(),
    private val userAgent: String = "melodious-catalog/1.0",
) : CatalogHttp {
    private val client: OkHttpClient = baseClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }

    private data class StoredCookie(
        val domain: String,
        val hostOnly: Boolean,
        val path: String,
        val name: String,
        val value: String,
        val expiresAtMillis: Long?,
    )

    private val cookies = LinkedHashMap<String, StoredCookie>()

    override fun clearCookies() {
        synchronized(cookies) { cookies.clear() }
    }

    override suspend fun get(url: String): CatalogHttpResponse =
        request(url, "GET", null, emptyMap(), authenticated = false)

    override suspend fun get(
        url: String,
        bearer: String?,
        extraHeaders: Map<String, String>,
        authenticated: Boolean,
    ): CatalogHttpResponse {
        val headers = LinkedHashMap<String, String>()
        headers.putAll(extraHeaders)
        if (authenticated && !bearer.isNullOrEmpty()) headers["Authorization"] = "Bearer $bearer"
        return request(url, "GET", null, headers, authenticated = authenticated)
    }

    override suspend fun postJson(
        url: String,
        payload: JsonElement,
        bearer: String?,
        extraHeaders: Map<String, String>,
    ): CatalogHttpResponse {
        val headers = LinkedHashMap<String, String>()
        headers["Content-Type"] = "application/json"
        headers.putAll(extraHeaders)
        if (!bearer.isNullOrEmpty()) headers["Authorization"] = "Bearer $bearer"
        return request(url, "POST", payload.toString().toRequestBody(JSON_MEDIA_TYPE), headers, authenticated = true)
    }

    override suspend fun postForm(url: String, fields: Map<String, String>): CatalogHttpResponse {
        val body = FormBody.Builder().apply {
            fields.forEach { (k, v) -> add(k, v) }
        }.build()
        return request(
            url, "POST", body,
            mapOf("Content-Type" to "application/x-www-form-urlencoded"),
            authenticated = true,
        )
    }

    private fun checkAllowed(url: String, method: String, authenticated: Boolean) {
        val allowed = (method == "POST" &&
            (url == DISCOVERY_URL || url == HARMONY_SIGNIN_URL || url == OAUTH_TOKEN_URL)) ||
            (method == "GET" && !authenticated && url.startsWith("$SEARCH_DEVICE_BASE_URL/manf/")) ||
            (method == "GET" && authenticated && PROTOCOL_LIST_URL_RE.matches(url)) ||
            (method == "POST" && listOf(
                "json2/SearchGlobalDevices",
                "json2/GetGlobalDevices",
                "json/GetGlobalLanguageCommands",
            ).any { url == DEVICE_MANAGER_BASE + it })
        val httpUrl = url.toHttpUrlOrNull()
        if (!allowed || httpUrl == null || httpUrl.scheme != "https" ||
            httpUrl.username.isNotEmpty() || httpUrl.password.isNotEmpty() || httpUrl.fragment != null
        ) {
            throw CatalogError("Refusing an unexpected catalog endpoint")
        }
    }

    private suspend fun request(
        url: String,
        method: String,
        body: okhttp3.RequestBody?,
        headers: Map<String, String>,
        authenticated: Boolean,
    ): CatalogHttpResponse {
        checkAllowed(url, method, authenticated)
        val httpUrl = url.toHttpUrlOrNull()
            ?: throw CatalogError("Refusing an unexpected catalog endpoint")
        val builder = Request.Builder()
            .url(httpUrl)
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
        headers.forEach { (k, v) -> builder.header(k, v) }
        if (method != "GET" || authenticated) {
            cookieHeader(url)?.let { builder.header("Cookie", it) }
        }
        when (method) {
            "GET" -> builder.get()
            else -> builder.post(body ?: "".toRequestBody(JSON_MEDIA_TYPE))
        }
        val call = client.newCall(builder.build())
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isCancelled) return
                    cont.resumeWithException(
                        CatalogError("Could not reach ${httpUrl.host}; try again")
                    )
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        recordResponseCookies(it.headers.values("Set-Cookie"), url)
                        val text = it.body?.string().orEmpty()
                        val payload = if (text.isBlank()) {
                            null
                        } else {
                            runCatching { json.parseToJsonElement(text) }.getOrNull()
                        }
                        if (cont.isActive) cont.resume(CatalogHttpResponse(it.code, payload))
                    }
                }
            })
        }
    }

    private fun recordResponseCookies(setCookies: List<String>, url: String) {
        val httpUrl = url.toHttpUrlOrNull() ?: return
        val now = System.currentTimeMillis()
        synchronized(cookies) {
            for (entry in setCookies) {
                val firstPart = entry.substringBefore(';').trim()
                val eq = firstPart.indexOf('=')
                if (eq <= 0) continue
                val name = firstPart.substring(0, eq).trim()
                val value = firstPart.substring(eq + 1).trim()
                if (name.isEmpty()) continue
                var domainAttr: String? = null
                var pathAttr: String? = null
                var maxAge: Long? = null
                var expiresAttr: String? = null
                for (attr in entry.split(';').drop(1)) {
                    val aEq = attr.indexOf('=')
                    val aName = (if (aEq >= 0) attr.substring(0, aEq) else attr).trim().lowercase()
                    val aValue = if (aEq >= 0) attr.substring(aEq + 1).trim() else ""
                    when (aName) {
                        "domain" -> domainAttr = aValue.lowercase().removePrefix(".")
                        "path" -> pathAttr = aValue
                        "max-age" -> maxAge = aValue.toLongOrNull()
                        "expires" -> expiresAttr = aValue
                    }
                }
                val host = httpUrl.host.lowercase()
                val domain = domainAttr ?: host
                if (domain != host && !(domain == "myharmony.com" && host.endsWith(".myharmony.com"))) {
                    continue
                }
                val path = if (!pathAttr.isNullOrEmpty() && pathAttr.startsWith("/")) {
                    pathAttr
                } else {
                    val p = httpUrl.encodedPath
                    p.substring(0, p.lastIndexOf('/') + 1).ifEmpty { "/" }
                }
                val expiresAt: Long? = when {
                    maxAge != null -> now + maxAge * 1000
                    expiresAttr != null -> parseHttpDate(expiresAttr)
                    else -> null
                }
                val key = "$domain|$path|$name"
                if (expiresAt != null && expiresAt <= now) {
                    cookies.remove(key)
                } else {
                    cookies[key] = StoredCookie(
                        domain = domain,
                        hostOnly = domainAttr == null,
                        path = path,
                        name = name,
                        value = value,
                        expiresAtMillis = expiresAt,
                    )
                }
            }
        }
    }

    private fun parseHttpDate(value: String): Long? = runCatching {
        ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
    }.getOrNull()

    private fun cookieHeader(url: String): String? {
        val httpUrl = url.toHttpUrlOrNull() ?: return null
        val host = httpUrl.host.lowercase()
        val requestPath = httpUrl.encodedPath
        val now = System.currentTimeMillis()
        val pairs = synchronized(cookies) {
            cookies.values.filter { c ->
                (c.expiresAtMillis == null || c.expiresAtMillis > now) &&
                    (host == c.domain || (!c.hostOnly && host.endsWith(".${c.domain}"))) &&
                    (requestPath == c.path ||
                        requestPath.startsWith(if (c.path.endsWith("/")) c.path else "${c.path}/"))
            }.map { "${it.name}=${it.value}" }
        }
        return pairs.takeIf { it.isNotEmpty() }?.joinToString("; ")
    }
}
