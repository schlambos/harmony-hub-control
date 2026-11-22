package app.melodious.protocol.rest

import app.melodious.protocol.catalog.CatalogCommandRow
import app.melodious.protocol.model.HubEndpoint
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

private data class CapturedRequest(
    val requestLine: String,
    val headers: Map<String, String>,
    val body: String,
)

/** One-shot loopback HTTP server on a plain ServerSocket (no new test dependency). */
private class OneShotServer(responseStatus: Int, responseBody: String) {
    private val server = ServerSocket(0)
    val port: Int get() = server.localPort
    @Volatile var captured: CapturedRequest? = null
    @Volatile var error: Throwable? = null

    private val worker = thread(start = true) {
        try {
            server.accept().use { socket: Socket ->
                val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.ISO_8859_1))
                val requestLine = reader.readLine() ?: ""
                val headers = LinkedHashMap<String, String>()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    val colon = line.indexOf(':')
                    if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] =
                        line.substring(colon + 1).trim()
                }
                val length = headers["content-length"]?.toInt() ?: 0
                val chars = CharArray(length)
                var read = 0
                while (read < length) {
                    val n = reader.read(chars, read, length - read)
                    if (n < 0) break
                    read += n
                }
                captured = CapturedRequest(requestLine, headers, String(chars, 0, read))
                val reason = if (responseStatus == 200) "OK" else "Not Found"
                val out = socket.getOutputStream()
                out.write(
                    ("HTTP/1.1 $responseStatus $reason\r\nContent-Type: application/json\r\n" +
                        "Content-Length: ${responseBody.toByteArray().size}\r\nConnection: close\r\n\r\n")
                        .toByteArray(Charsets.ISO_8859_1)
                )
                out.write(responseBody.toByteArray())
                out.flush()
            }
        } catch (t: Throwable) {
            error = t
        } finally {
            runCatching { server.close() }
        }
    }

    fun join() {
        worker.join(10_000)
        error?.let { throw AssertionError("loopback server failed", it) }
    }
}

class CodexHubCatalogTest {

    @Test
    fun `importCatalogCommands sends a fixed Content-Length JSON body and parses the reply`() = runBlocking {
        val server = OneShotServer(200, """{"ok":true,"message":"Imported 1 command"}""")
        val client = CodexHubRestClient()
        val endpoint = HubEndpoint(name = "test", host = "127.0.0.1", webUiPort = server.port)
        val reply = client.importCatalogCommands(
            endpoint,
            deviceId = "167856",
            rows = listOf(
                CatalogCommandRow("PowerOn", "G:Sony 15 Bit:()(0x3A0C)():3", "", "Sony 15 Bit"),
                CatalogCommandRow("LearnedRaw", "", "F38000P500S500", ""),
            ),
        )
        server.join()
        val req = server.captured!!
        assertTrue(req.requestLine.startsWith("POST /api/catalog-import "))
        assertFalse(req.headers.containsKey("transfer-encoding"))
        val bodyBytes = req.body.toByteArray(Charsets.UTF_8)
        assertEquals(bodyBytes.size.toString(), req.headers["content-length"])
        val body = Json.parseToJsonElement(req.body).jsonObject
        assertEquals("167856", body["deviceId"]?.jsonPrimitive?.content)
        val commands = body["commands"]!!.toString()
        assertTrue(commands.contains("\"name\":\"PowerOn\""))
        assertTrue(commands.contains("\"keycode\":\"G:Sony 15 Bit:()(0x3A0C)():3\""))
        assertTrue(commands.contains("\"raw\":\"F38000P500S500\""))
        assertTrue(commands.contains("\"protocol\":\"Sony 15 Bit\""))
        assertEquals(true, reply["ok"]?.jsonPrimitive?.content?.toBoolean())
        assertEquals("Imported 1 command", reply["message"]?.jsonPrimitive?.content)
    }

    @Test
    fun `importCatalogCommands maps a 404 to the older-hub message`() = runBlocking {
        val server = OneShotServer(404, """{"ok":false,"message":"not found"}""")
        val client = CodexHubRestClient()
        val endpoint = HubEndpoint(name = "test", host = "127.0.0.1", webUiPort = server.port)
        val error = assertThrows(HubApiException::class.java) {
            runBlocking {
                client.importCatalogCommands(endpoint, "1", listOf(CatalogCommandRow("A", "G:X:1", "", "X")))
            }
        }
        server.join()
        assertEquals(404, error.statusCode)
        assertEquals(
            "Your hub's Melodious software is older than this app; update the hub",
            error.message,
        )
    }

    @Test
    fun `getHubProtocolNames parses the ProtocolList export`() = runBlocking {
        val server = OneShotServer(
            200,
            """{"Protocols":[{"Name":"Sony 15 Bit"},{"Name":"Sony 20 Bit"},{}]}""",
        )
        val client = CodexHubRestClient()
        val endpoint = HubEndpoint(name = "test", host = "127.0.0.1", webUiPort = server.port)
        val names = client.getHubProtocolNames(endpoint)
        server.join()
        assertEquals(listOf("Sony 15 Bit", "Sony 20 Bit"), names)
        assertTrue(server.captured!!.requestLine.startsWith("GET /export/protocols "))
    }

    @Test
    fun `getHubProtocolNames throws on an unparseable reply`() = runBlocking {
        val server = OneShotServer(200, "not json at all")
        val client = CodexHubRestClient()
        val endpoint = HubEndpoint(name = "test", host = "127.0.0.1", webUiPort = server.port)
        assertThrows(HubApiException::class.java) {
            runBlocking { client.getHubProtocolNames(endpoint) }
        }
        server.join()
    }

    @Test
    fun `getSupportedHubProtocolNames merges built-ins and importCatalogCommands sends bundled protocols`() = runBlocking {
        val protoServer = OneShotServer(200, """{"Protocols":[]}""")
        val client = CodexHubRestClient()
        val protoEp = HubEndpoint(name = "test", host = "127.0.0.1", webUiPort = protoServer.port)
        val supported = client.getSupportedHubProtocolNames(protoEp)
        protoServer.join()
        assertTrue(supported.contains("Samsung 16 and 20 Bit"))
        assertTrue(supported.contains("Sony 15 Bit"))

        val importServer = OneShotServer(200, """{"ok":true,"message":"Imported: 1"}""")
        val importEp = HubEndpoint(name = "test", host = "127.0.0.1", webUiPort = importServer.port)
        val bundled = Json.parseToJsonElement(
            """{"__type":"IrProtocol","Id-":777,"Name":"Fixture Custom 24 Bit","CarrierFrequency":38000,"IRSegments":[{"Name":"Fixture Custom 24 Bit"}],"CodeSegments":[],"KeyCode":{"Start":null,"Repeat":[{"SegmentType":1,"SegmentName":"Fixture Custom 24 Bit"}],"Finish":null}}"""
        ).jsonObject
        client.importCatalogCommands(
            importEp,
            deviceId = "167856",
            rows = listOf(CatalogCommandRow("PowerOn", "G:Fixture Custom 24 Bit:()(0x123456)():3", "", "Fixture Custom 24 Bit")),
            protocols = listOf(bundled),
        )
        importServer.join()
        val reqBody = Json.parseToJsonElement(importServer.captured!!.body).jsonObject
        assertTrue(reqBody.containsKey("protocols"))
        assertTrue(reqBody["protocols"].toString().contains("Fixture Custom 24 Bit"))
    }
}
