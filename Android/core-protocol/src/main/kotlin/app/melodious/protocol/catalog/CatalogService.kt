package app.melodious.protocol.catalog

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant

data class CatalogSession(val accountId: String, val tokens: CatalogTokens)

data class CatalogStatus(val signedIn: Boolean)

suspend fun harmonySignin(http: CatalogHttp, tokens: CatalogTokens): CatalogSession {
    val body = buildJsonObject {
        put("access_token", JsonPrimitive(tokens.accessToken))
        put("id_token", JsonPrimitive(tokens.idToken))
    }
    val (status, payload) = http.postJson(HARMONY_SIGNIN_URL, body, bearer = tokens.accessToken)
    if (status != 200) {
        throw CatalogError(rejectedMessage("Harmony rejected the bootstrap", status, browserHint = true))
    }
    val obj = payload as? JsonObject
        ?: throw CatalogError("Harmony's signin did not return an object")
    val inner = (obj["SigninResult"] as? JsonObject) ?: obj
    val accountId = ((inner["AccountId"] ?: obj["AccountId"]) as? JsonPrimitive)
        ?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        ?: throw CatalogError("Harmony's signin did not return an AccountId")
    val locked = (inner["IsLockedOut"] as? JsonPrimitive)?.booleanOrNull == true ||
        (obj["IsLockedOut"] as? JsonPrimitive)?.booleanOrNull == true
    if (locked) throw CatalogError("the Harmony account is locked")
    return CatalogSession(accountId, tokens)
}

/**
 * The signed-in catalog session, ported from the desktop app's catalog
 * service: saved tokens first, one silent refresh, then one browser
 * sign-in. Every call is serialized; status is local and never networks.
 */
class CatalogService(
    private val http: CatalogHttp,
    private val tokenStore: TokenStore,
    private val signInLauncher: SignInLauncher? = null,
    private val clientIdProvider: () -> String = { DEFAULT_CLIENT_ID },
) {
    private val mutex = Mutex()
    private var inMemoryTokens: CatalogTokens? = null
    private var currentSession: CatalogSession? = null
    private var cachedOperations: Map<String, CatalogOperation>? = null

    private data class LastSearch(
        val manufacturer: String,
        val model: String,
        val raw: JsonElement,
        val matches: List<JsonObject>,
    )

    private var lastSearch: LastSearch? = null

    fun status(): CatalogStatus =
        CatalogStatus(currentSession != null || loadStoredTokens() != null)

    suspend fun signIn(): CatalogStatus = mutex.withLock {
        try {
            ensureActiveSessionLocked()
            CatalogStatus(true)
        } catch (e: CatalogError) {
            if (e.message == "Sign in to Logitech first") CatalogStatus(false) else throw e
        }
    }

    suspend fun signOut(): CatalogStatus = mutex.withLock {
        clearStoredLocked()
        CatalogStatus(false)
    }

    internal suspend fun ensureSession(): CatalogSession = mutex.withLock {
        ensureActiveSessionLocked()
    }

    private suspend fun ensureActiveSessionLocked(): CatalogSession {
        currentSession?.let { return it }
        try {
            val session = ensureSessionLocked()
            currentSession = session
            return session
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            clearStoredLocked()
            throw e
        }
    }

    private suspend fun ensureSessionLocked(): CatalogSession {
        var tokens = loadStoredTokens()
        if (tokens != null) {
            try {
                return harmonySignin(http, tokens)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Saved access_token rejected; try one silent refresh next.
            }
            try {
                val refreshed = oauthRefresh(http, tokens, clientIdProvider())
                saveStoredTokens(refreshed)
                tokens = refreshed
                return harmonySignin(http, refreshed)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Silent refresh failed; fall through to interactive sign-in once.
            }
        }

        val launcher = signInLauncher ?: throw CatalogError("Sign in to Logitech first")
        val pair = pkcePair()
        val clientId = clientIdProvider()
        val url = authorizeUrl(clientId, pair.challenge, pair.state)
        val freshTokens = when (val result = launcher.launch(url)) {
            SignInLaunchResult.Cancelled -> throw CatalogError("Sign in to Logitech first")
            is SignInLaunchResult.Returned -> {
                val code = parseCallback(result.callbackUrl, pair.state)
                oauthExchange(http, clientId, code, pair.verifier)
            }
        }
        saveStoredTokens(freshTokens)
        return harmonySignin(http, freshTokens)
    }

    private fun loadStoredTokens(): CatalogTokens? {
        inMemoryTokens?.let { return it }
        val stored = runCatching { tokenStore.load() }.getOrNull()
        if (stored != null) inMemoryTokens = stored
        return stored
    }

    private fun saveStoredTokens(tokens: CatalogTokens) {
        inMemoryTokens = tokens
        runCatching { tokenStore.save(tokens) }
    }

    private fun clearStoredLocked() {
        inMemoryTokens = null
        currentSession = null
        cachedOperations = null
        lastSearch = null
        runCatching { tokenStore.clear() }
        runCatching { http.clearCookies() }
    }

    private fun validateCatalogString(value: String, fieldName: String): String {
        if (value.any { it.code <= 0x1F || it.code == 0x7F }) {
            throw CatalogError("Invalid $fieldName: control characters are not allowed")
        }
        val trimmed = value.trim()
        if (trimmed.length !in 1..64) {
            throw CatalogError("Invalid $fieldName: must be 1 to 64 characters")
        }
        return trimmed
    }

    private fun validateCatalogId(id: Long): Long {
        if (id <= 0) throw CatalogError("Invalid catalog device id: must be a positive integer")
        return id
    }

    suspend fun checkModel(manufacturer: String, model: String): CatalogModelCheck {
        val m = validateCatalogString(manufacturer, "manufacturer")
        val n = validateCatalogString(model, "model")
        return mutex.withLock { checkDeviceModel(http, m, n) }
    }

    suspend fun search(manufacturer: String, model: String): List<CatalogSearchMatch> {
        val m = validateCatalogString(manufacturer, "manufacturer")
        val n = validateCatalogString(model, "model")
        return mutex.withLock {
            lastSearch = null
            val raw = withCatalogRetryLocked { catalog -> catalog.search(m, n) }
            val matches = searchMatches(raw)
            if (matches.isEmpty()) {
                throw CatalogError("No catalog device matches $m $n")
            }
            lastSearch = LastSearch(m, n, raw, matches)
            formatSearchMatches(matches, m, n)
        }
    }

    suspend fun download(id: Long, manufacturer: String, model: String): JsonObject {
        val validId = validateCatalogId(id)
        val m = validateCatalogString(manufacturer, "manufacturer")
        val n = validateCatalogString(model, "model")
        return mutex.withLock {
            withCatalogRetryLocked { catalog ->
                val result = catalog.globalDevices(listOf(validId))
                val arr = result as? JsonArray
                val device = arr?.singleOrNull() as? JsonObject
                    ?: throw CatalogError("GetGlobalDevices did not return the device")
                val returnedId = ((device["Id"] ?: device["Id-"]) as? JsonPrimitive)
                    ?.let { parseIntegerElement(it) }
                if (returnedId != validId) {
                    throw CatalogError("The catalog returned a different device; search again")
                }
                val versionPrim = device["DefaultGlobalLanguageVersionId"] as? JsonPrimitive
                if (versionPrim == null || versionPrim is kotlinx.serialization.json.JsonNull ||
                    versionPrim.booleanOrNull != null
                ) {
                    throw CatalogError("the device carries no language version id")
                }
                val commands = catalog.globalLanguageCommands(versionPrim)
                if (commands !is JsonArray) {
                    throw CatalogError("The catalog returned no command list")
                }
                val (needIds, needNames) = neededProtocolRefs(commands)
                val bundledProtocols = if (needIds.isNotEmpty() || needNames.isNotEmpty()) {
                    try {
                        selectNeededProtocols(catalog.protocolList(), commands)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: CatalogError) {
                        if (e.accessDenied) throw e
                        emptyList()
                    } catch (_: Exception) {
                        emptyList()
                    }
                } else {
                    emptyList()
                }
                val matched = lastSearch?.matches?.firstOrNull { candidate ->
                    ((candidate["Id-"] ?: candidate["Id"]) as? JsonPrimitive)
                        ?.let { parseIntegerElement(it) } == validId
                } ?: buildJsonObject {
                    put("Id-", JsonPrimitive(validId))
                    put("Manufacturer", m)
                    put("DeviceModel", n)
                }
                val searchResult: JsonElement = lastSearch?.raw ?: buildJsonObject {
                    put("Matches", buildJsonArray { add(matched) })
                    put("Status", JsonPrimitive(0))
                }
                buildPackage(
                    manufacturer = m,
                    model = n,
                    searchResult = searchResult,
                    selectedMatch = matched,
                    globalDevice = device,
                    languageCommands = commands,
                    generatedAt = Instant.now().toString(),
                    protocols = JsonArray(bundledProtocols),
                )
            }
        }
    }

    private suspend fun <T> withCatalogRetryLocked(action: suspend (GlobalCatalogClient) -> T): T {
        val session = ensureActiveSessionLocked()
        var catalog = GlobalCatalogClient(http, session, cachedOperations)
        try {
            val result = action(catalog)
            cachedOperations = catalog.operations()
            return result
        } catch (e: CancellationException) {
            throw e
        } catch (e: CatalogError) {
            if (!e.accessDenied) throw e
            val refreshToken = session.tokens.refreshToken
            if (refreshToken.isNullOrEmpty()) {
                clearStoredLocked()
                throw e
            }
            try {
                val refreshed = oauthRefresh(http, session.tokens, clientIdProvider())
                saveStoredTokens(refreshed)
                val newSession = harmonySignin(http, refreshed)
                currentSession = newSession
                catalog = GlobalCatalogClient(http, newSession, cachedOperations)
                val result = action(catalog)
                cachedOperations = catalog.operations()
                return result
            } catch (e2: CancellationException) {
                throw e2
            } catch (_: Exception) {
                clearStoredLocked()
                throw CatalogError("Logitech refused the catalog session; sign in again")
            }
        }
    }
}
