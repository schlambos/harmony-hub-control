package app.melodious.protocol.catalog

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

private class FakeTokenStore2(var stored: CatalogTokens? = null) : TokenStore {
    override fun load(): CatalogTokens? = stored
    override fun save(tokens: CatalogTokens) { stored = tokens }
    override fun clear() { stored = null }
}

private enum class DenyMode { NEVER, ONCE, ALWAYS }

/**
 * Fake transport keyed by URL: Harmony signin accepts any bearer, discovery
 * and the three operations serve the shared fixtures, the token endpoint
 * answers refreshes, and operation POSTs can answer "Access is denied".
 */
private class CatalogFakeHttp(
    private val fixtures: JsonObject,
    var denyMode: DenyMode = DenyMode.NEVER,
) : CatalogHttp {
    val opAttempts = AtomicInteger(0)
    val refreshCalls = AtomicInteger(0)
    val transportCalls = AtomicInteger(0)
    val inFlight = AtomicInteger(0)
    val maxInFlight = AtomicInteger(0)
    var cookiesCleared = false
    var delayMs: Long = 0

    override suspend fun get(url: String): CatalogHttpResponse {
        transportCalls.incrementAndGet()
        val now = inFlight.incrementAndGet()
        maxInFlight.accumulateAndGet(now) { a, b -> maxOf(a, b) }
        try {
            if (delayMs > 0) delay(delayMs)
            return if (url.contains("/manf/Sony/model/STR-DG720/")) {
                CatalogHttpResponse(200, fixture(fixtures, "searchDeviceFound"))
            } else {
                CatalogHttpResponse(200, fixture(fixtures, "searchDeviceNotFound"))
            }
        } finally {
            inFlight.decrementAndGet()
        }
    }

    override suspend fun postJson(
        url: String,
        payload: JsonElement,
        bearer: String?,
        extraHeaders: Map<String, String>,
    ): CatalogHttpResponse {
        transportCalls.incrementAndGet()
        return when {
            url == HARMONY_SIGNIN_URL -> CatalogHttpResponse(
                200, buildJsonObject { put("AccountId", "fixture-account") }
            )
            url == DISCOVERY_URL -> CatalogHttpResponse(200, fixture(fixtures, "discovery"))
            url.contains("/DeviceManager.svc/") -> {
                opAttempts.incrementAndGet()
                val deny = when (denyMode) {
                    DenyMode.NEVER -> false
                    DenyMode.ALWAYS -> true
                    DenyMode.ONCE -> opAttempts.get() == 1
                }
                if (deny) {
                    CatalogHttpResponse(400, buildJsonObject {
                        put("ErrorCode", JsonPrimitive(5))
                        put("Message", "Access is denied.")
                    })
                } else when {
                    url.endsWith("/json2/SearchGlobalDevices") ->
                        CatalogHttpResponse(200, fixture(fixtures, "searchGlobalDevices"))
                    url.endsWith("/json2/GetGlobalDevices") ->
                        CatalogHttpResponse(200, fixture(fixtures, "getGlobalDevices"))
                    url.endsWith("/json/GetGlobalLanguageCommands") ->
                        CatalogHttpResponse(200, fixture(fixtures, "getGlobalLanguageCommands"))
                    else -> throw AssertionError("unexpected operation POST $url")
                }
            }
            else -> throw AssertionError("unexpected POST $url")
        }
    }

    override suspend fun postForm(url: String, fields: Map<String, String>): CatalogHttpResponse {
        transportCalls.incrementAndGet()
        assertEquals(OAUTH_TOKEN_URL, url)
        refreshCalls.incrementAndGet()
        return CatalogHttpResponse(200, buildJsonObject {
            put("access_token", "refreshed-acc")
            put("id_token", "refreshed-id")
            put("refresh_token", "refreshed-ref")
        })
    }

    override fun clearCookies() { cookiesCleared = true }
}

class CatalogClientServiceTest {

    private val fixtures = loadCatalogFixtures()

    private fun savedService(http: CatalogFakeHttp, store: FakeTokenStore2): CatalogService =
        CatalogService(http, store, object : SignInLauncher {
            override suspend fun launch(authorizeUrl: String): SignInLaunchResult =
                throw AssertionError("no browser prompt expected")
        })

    @Test
    fun `search formats the one fixture match`() = runBlocking {
        val http = CatalogFakeHttp(fixtures)
        val store = FakeTokenStore2(CatalogTokens("saved-acc", "saved-id", "saved-ref"))
        val service = savedService(http, store)
        val matches = service.search("Sony", "STR-DG7")
        assertEquals(1, matches.size)
        val m = matches[0]
        assertEquals(167856L, m.id)
        assertEquals("Sony", m.manufacturer)
        assertEquals("STR-DG720", m.model)
        assertEquals("Sony STR-DG720", m.displayText)
        assertEquals("Receiver", m.deviceType)
        assertEquals("", m.description)
    }

    @Test
    fun `download builds the Android 0_2_0 package with the fixture command count`() = runBlocking {
        val http = CatalogFakeHttp(fixtures)
        val store = FakeTokenStore2(CatalogTokens("saved-acc", "saved-id", "saved-ref"))
        val service = savedService(http, store)
        service.search("Sony", "STR-DG7")
        val pkg = service.download(167856, "Sony", "STR-DG720")
        assertEquals("0.2.0", (pkg["schema_version"] as JsonPrimitive).content)
        assertEquals("logitech-catalog-via-melodious-android", (pkg["source"] as JsonPrimitive).content)
        val query = pkg["query"] as JsonObject
        assertEquals("Sony", (query["manufacturer"] as JsonPrimitive).content)
        assertEquals("STR-DG720", (query["model"] as JsonPrimitive).content)
        val commands = (pkg["resources"] as JsonObject)["global_language_commands"] as JsonArray
        assertEquals(5, commands.size)
        assertTrue(isCatalogPackage(pkg))
    }

    @Test
    fun `access denied once refreshes exactly once and the result still arrives`() = runBlocking {
        val http = CatalogFakeHttp(fixtures, DenyMode.ONCE)
        val store = FakeTokenStore2(CatalogTokens("saved-acc", "saved-id", "saved-ref"))
        val service = savedService(http, store)
        val matches = service.search("Sony", "STR-DG7")
        assertEquals(1, matches.size)
        assertEquals(1, http.refreshCalls.get())
        assertEquals("refreshed-acc", store.stored?.accessToken)
        assertEquals("refreshed-ref", store.stored?.refreshToken)
        assertTrue(service.status().signedIn)
    }

    @Test
    fun `access denied always refreshes once, tries twice, clears tokens, and never prompts`() = runBlocking {
        val http = CatalogFakeHttp(fixtures, DenyMode.ALWAYS)
        val store = FakeTokenStore2(CatalogTokens("saved-acc", "saved-id", "saved-ref"))
        var prompts = 0
        val service = CatalogService(http, store, object : SignInLauncher {
            override suspend fun launch(authorizeUrl: String): SignInLaunchResult {
                prompts++
                return SignInLaunchResult.Cancelled
            }
        })
        val error = assertThrows(CatalogError::class.java) {
            runBlocking { service.search("Sony", "STR-DG7") }
        }
        assertEquals("Logitech refused the catalog session; sign in again", error.message)
        assertEquals(1, http.refreshCalls.get())
        assertEquals(2, http.opAttempts.get())
        assertEquals(null, store.stored)
        assertFalse(service.status().signedIn)
        assertEquals(0, prompts)
    }

    @Test
    fun `calls never overlap and status makes no transport calls`() = runBlocking {
        val http = CatalogFakeHttp(fixtures)
        http.delayMs = 25
        val service = CatalogService(http, FakeTokenStore2(), null)
        assertFalse(service.status().signedIn)
        assertEquals(0, http.transportCalls.get())
        val results = (1..6).map { async { service.checkModel("Sony", "STR-DG720") } }.awaitAll()
        assertTrue(results.all { it.found })
        assertEquals(1, http.maxInFlight.get())
    }

    @Test
    fun `checkModel is anonymous and never touches the session`() = runBlocking {
        val http = CatalogFakeHttp(fixtures)
        val service = CatalogService(http, FakeTokenStore2(), null)
        val found = service.checkModel("Sony", "STR-DG720")
        assertTrue(found.found)
        // Only the one GET; no signin/discovery/token call happened.
        assertEquals(1, http.transportCalls.get())
    }

    @Test
    fun `validation refuses blank, overlong and non-positive inputs before any transport`() = runBlocking {
        val http = CatalogFakeHttp(fixtures)
        val store = FakeTokenStore2(CatalogTokens("saved-acc", "saved-id", "saved-ref"))
        val service = savedService(http, store)
        val long = "x".repeat(65)
        for (call in listOf<suspend () -> Unit>(
            { service.checkModel("", "STR-DG720") },
            { service.checkModel("Sony", "  ") },
            { service.search(long, "STR-DG7") },
            { service.search("Sony", long) },
            { service.download(0, "Sony", "STR-DG720") },
            { service.download(-5, "Sony", "STR-DG720") },
        )) {
            assertThrows(CatalogError::class.java) { runBlocking { call() } }
        }
        assertEquals(0, http.transportCalls.get())
    }

    @Test
    fun `download bundles matching IrProtocols from UserAccountDirector ProtocolList`() = runBlocking {
        val customProto = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"__type":"IrProtocol","Id-":999,"Name":"RC6 Mode 0","CarrierFrequency":36000,"IRSegments":[{"Name":"RC6 Mode 0"}],"CodeSegments":[],"KeyCode":{"Start":null,"Repeat":[{"SegmentType":1,"SegmentName":"RC6 Mode 0"}],"Finish":null}}"""
        ) as JsonObject
        val seenGets = mutableListOf<String>()
        val http = object : CatalogHttp {
            override suspend fun get(url: String): CatalogHttpResponse =
                throw AssertionError("unexpected anonymous GET $url")

            override suspend fun get(
                url: String,
                bearer: String?,
                extraHeaders: Map<String, String>,
                authenticated: Boolean,
            ): CatalogHttpResponse {
                seenGets.add(url)
                assertTrue(authenticated)
                assertEquals("saved-acc", bearer)
                assertEquals("1", extraHeaders["x-logitech-api-version"])
                return CatalogHttpResponse(200, buildJsonObject {
                    put("Protocols", kotlinx.serialization.json.buildJsonArray {
                        add(customProto)
                        add(buildJsonObject { put("__type", "HidProtocol"); put("Id-", JsonPrimitive(999997)); put("Name", "HID 16 Bit") })
                    })
                })
            }

            override suspend fun postJson(
                url: String,
                payload: JsonElement,
                bearer: String?,
                extraHeaders: Map<String, String>,
            ): CatalogHttpResponse = when {
                url == HARMONY_SIGNIN_URL -> CatalogHttpResponse(200, buildJsonObject { put("AccountId", "acct-77") })
                url == DISCOVERY_URL -> {
                    val baseOps = (fixture(fixtures, "discovery") as JsonObject)["GetJsonOperationsResult"] as JsonArray
                    CatalogHttpResponse(200, buildJsonObject {
                        put("GetJsonOperationsResult", kotlinx.serialization.json.buildJsonArray {
                            baseOps.forEach { add(it) }
                            add(buildJsonObject {
                                put("Identifier", PROTOCOL_LIST_OPERATION)
                                put("Address", "https://svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json/Account/{accountId}/")
                                put("Name", "ProtocolList")
                            })
                        })
                    })
                }
                url.endsWith("/json2/GetGlobalDevices") -> CatalogHttpResponse(200, fixture(fixtures, "getGlobalDevices"))
                url.endsWith("/json/GetGlobalLanguageCommands") -> CatalogHttpResponse(200, fixture(fixtures, "getGlobalLanguageCommands"))
                else -> throw AssertionError("unexpected POST $url")
            }

            override suspend fun postForm(url: String, fields: Map<String, String>): CatalogHttpResponse =
                throw AssertionError("unexpected form POST $url")

            override fun clearCookies() {}
        }
        val service = CatalogService(http, FakeTokenStore2(CatalogTokens("saved-acc", "saved-id", "saved-ref")))
        val pkg = service.download(167856, "Sony", "STR-DG720")
        assertEquals(
            listOf("https://lb-svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json2/Account/acct-77/ProtocolList"),
            seenGets,
        )
        val protocols = (pkg["resources"] as JsonObject)["protocols"] as JsonArray
        assertEquals(1, protocols.size)
        assertEquals("RC6 Mode 0", ((protocols[0] as JsonObject)["Name"] as JsonPrimitive).content)
        assertFalse(pkg.toString().contains("acct-77"))
    }
}
