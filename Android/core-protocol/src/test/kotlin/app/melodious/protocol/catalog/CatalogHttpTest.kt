package app.melodious.protocol.catalog

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CatalogHttpTest {

    @Test
    fun `transport refuses unexpected endpoints before any request`(): Unit = runBlocking {
        val http = OkHttpCatalogHttp()
        assertThrows(CatalogError::class.java) {
            runBlocking {
                http.postJson("https://untrusted.example/", buildJsonObject { }, bearer = "fixture")
            }
        }
        assertThrows(CatalogError::class.java) {
            runBlocking { http.postForm("http://accounts.logi.com/identity/oauth2/token", emptyMap()) }
        }
        assertThrows(CatalogError::class.java) {
            runBlocking { http.get("https://lb-svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json2/SearchGlobalDevices") }
        }
    }

    @Test
    fun `forms encode, cookies stay scoped, and model check sends none`(): Unit = runBlocking {
        val seen = mutableListOf<Request>()
        val fake = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                seen.add(request)
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .header("Set-Cookie", "session=fixture-cookie; Path=/")
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()
        val http = OkHttpCatalogHttp(fake)
        http.postForm(OAUTH_TOKEN_URL, mapOf("grant_type" to "authorization_code", "code" to "a +&b"))
        assertEquals("application/x-www-form-urlencoded", seen[0].header("Content-Type"))
        val formBody = okio.Buffer().also { seen[0].body!!.writeTo(it) }.readUtf8()
        val sentCode = formBody.split('&').first { it.startsWith("code=") }.substringAfter('=')
        assertEquals("a +&b", java.net.URLDecoder.decode(sentCode, "UTF-8"))

        http.postJson(HARMONY_SIGNIN_URL, buildJsonObject { }, bearer = "fixture-bearer")
        assertEquals(null, seen[1].header("Cookie"))

        http.postJson(
            "https://lb-svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json2/SearchGlobalDevices",
            buildJsonObject { },
        )
        assertEquals("session=fixture-cookie", seen[2].header("Cookie"))

        http.get("$SEARCH_DEVICE_BASE_URL/manf/Sony/model/STR-DG720/iface/IR")
        assertEquals(null, seen[3].header("Cookie"))
        assertEquals(null, seen[3].header("Authorization"))

        // Unauthenticated GET to ProtocolList is refused; authenticated GET sends Cookie + Bearer.
        assertThrows(CatalogError::class.java) {
            runBlocking {
                http.get("https://lb-svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json2/Account/acct-1/ProtocolList")
            }
        }
        http.get(
            "https://lb-svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json2/Account/acct-1/ProtocolList",
            bearer = "fixture-bearer",
            extraHeaders = mapOf("x-logitech-api-version" to "1"),
            authenticated = true,
        )
        assertEquals("session=fixture-cookie", seen[4].header("Cookie"))
        assertEquals("Bearer fixture-bearer", seen[4].header("Authorization"))
        assertEquals("1", seen[4].header("x-logitech-api-version"))
    }
}
