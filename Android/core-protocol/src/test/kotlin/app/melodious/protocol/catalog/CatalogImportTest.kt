package app.melodious.protocol.catalog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private val PKG_JSON = """
{
  "schema_version": "0.2.0",
  "resources": {
    "global_language_commands": [
      { "Name": "PowerOn", "KeyCode": "G:Sony 15 Bit:()(0x3A0C)():3", "ProtocolId": 17 },
      { "Name": "PowerOff", "KeyCode": "G:Sony 15 Bit:()(0x7A0C)():3", "ProtocolId": 17 },
      { "Name": "VolumeUp", "KeyCode": "G:Sony 15 Bit:()(0x240C)():3", "ProtocolId": 17 },
      { "Name": "SmartKey", "KeyCode": "G:RC6 Mode 0:()(0x1)():0", "ProtocolId": 999 },
      { "Name": "LearnedRaw", "KeyCode": "", "Raw": "F38000P500S500" },
      { "Name": "Broken", "KeyCode": "", "Raw": "" },
      { "Name": "", "KeyCode": "G:Sony 15 Bit:()(0x1)():3", "ProtocolId": 17 }
    ]
  }
}
""".trimIndent()

class CatalogImportTest {

    private fun pkg() = Json.parseToJsonElement(PKG_JSON)

    @Test
    fun `isCatalogPackage mirrors the JS accept and reject set`() {
        assertTrue(isCatalogPackage(pkg()))
        assertTrue(isCatalogPackage(Json.parseToJsonElement("""{"schema_version":"0.2.0","resources":{"global_language_commands":[]}}""")))
        for (bad in listOf(
            "null",
            "[]",
            "{}",
            "\"0.2.0\"",
            """{"schema_version":"1.0","resources":{"global_language_commands":[]}}""",
            """{"schema_version":"0.2.0","resources":{"global_language_commands":{}}}""",
        )) {
            assertFalse("should reject: $bad", isCatalogPackage(Json.parseToJsonElement(bad)))
        }
    }

    @Test
    fun `catalogRows imports only KeyCodes whose protocol is on the hub`() {
        val result = catalogRows(pkg(), listOf("Sony 15 Bit", "Toshiba 32 Bit"))
        assertEquals(listOf("PowerOn", "PowerOff", "VolumeUp", "LearnedRaw"), result.rows.map { it.name })
        assertEquals(listOf("Sony 15 Bit"), result.protocolsUsed)
        assertEquals(listOf("RC6 Mode 0"), result.missingProtocols)
        assertEquals(3, result.skipped.size)
        assertTrue(result.skipped[0].reason.contains("RC6 Mode 0"))
        // Exact JS wording, including the curly quotes.
        assertEquals("protocol “RC6 Mode 0” is not on this hub", result.skipped[0].reason)
        assertEquals("(unnamed)", result.skipped[2].name)
        assertEquals("no command name", result.skipped[2].reason)
        // The Raw row carries no keycode; the KeyCode rows carry no raw.
        assertEquals("", result.rows[3].keycode)
        assertEquals("F38000P500S500", result.rows[3].raw)
        assertEquals("G:Sony 15 Bit:()(0x3A0C)():3", result.rows[0].keycode)
        assertEquals("", result.rows[0].raw)
        assertEquals("Sony 15 Bit", result.rows[0].protocol)
    }

    @Test
    fun `catalogRows refuses every KeyCode when no protocol list is known`() {
        val result = catalogRows(pkg(), emptyList())
        assertEquals(listOf("LearnedRaw"), result.rows.map { it.name })
        assertEquals(listOf("RC6 Mode 0", "Sony 15 Bit"), result.missingProtocols.sorted())
    }

    @Test
    fun `catalogRows handles a package without commands`() {
        val result = catalogRows(Json.parseToJsonElement("""{"resources":{}}"""), listOf("Sony 15 Bit"))
        assertEquals(0, result.rows.size)
        assertEquals(0, result.skipped.size)
    }

    @Test
    fun `catalogRows reports every skip reason`() {
        val tricky = Json.parseToJsonElement(
            """
            {"resources":{"global_language_commands":[
              {"Name":"NoProto","KeyCode":"G::(0x1)"},
              {"Name":"BadForm","KeyCode":"X:1"},
              {"Name":"Empty","KeyCode":"","Raw":""}
            ]}}
            """.trimIndent()
        )
        val result = catalogRows(tricky, listOf("Sony 15 Bit"))
        assertEquals(listOf("KeyCode names no protocol", "KeyCode is not in Harmony G: form", "no KeyCode or Raw code"),
            result.skipped.map { it.reason })
    }

    @Test
    fun `describeCatalogRows summarises importable, skipped and missing protocols`() {
        val text = describeCatalogRows(catalogRows(pkg(), listOf("Sony 15 Bit")))
        assertTrue(text.startsWith("4 importable"))
        assertTrue(text.contains("Sony 15 Bit"))
        assertTrue(text.contains("missing on hub: RC6 Mode 0"))
        assertEquals(
            "4 importable · protocols: Sony 15 Bit · 3 skipped · missing on hub: RC6 Mode 0",
            text,
        )
    }

    @Test
    fun `hubProtocolNames reads names out of a ProtocolList export`() {
        assertEquals(
            listOf("Sony 15 Bit", "Toshiba 32 Bit"),
            hubProtocolNames(
                Json.parseToJsonElement(
                    """{"Protocols":[{"Name":"Sony 15 Bit"},{"Name":"Toshiba 32 Bit"},{}]}"""
                )
            ),
        )
        assertEquals(emptyList<String>(), hubProtocolNames(null))
        assertEquals(emptyList<String>(), hubProtocolNames(JsonPrimitive("junk")))
    }

    @Test
    fun `supportedHubProtocolNames includes all 6 built-in hub protocols and imports Samsung 16 and 20 Bit on blank ProtocolList`() {
        assertEquals(
            listOf(
                "Toshiba 32 Bit",
                "Sony 15 Bit",
                "Sony 20 Bit",
                "Saitek 11 Bit",
                "MemorexO1 32 Bit",
                "Samsung 16 and 20 Bit",
            ),
            BUILTIN_HUB_PROTOCOLS,
        )
        val blankHub = supportedHubProtocolNames(Json.parseToJsonElement("""{"Protocols":[]}"""))!!
        assertEquals(BUILTIN_HUB_PROTOCOLS, blankHub)
        assertEquals(null, supportedHubProtocolNames(null))
        assertEquals(null, supportedHubProtocolNames(Json.parseToJsonElement("{}")))

        val samsungPkg = Json.parseToJsonElement(
            """
            {
              "schema_version": "0.2.0",
              "resources": {
                "global_language_commands": [
                  {"Name":"BluetoothPairing","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x0B946)():3","ProtocolId":686,"Raw":null},
                  {"Name":"DirectionDown","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x0AD52)():3","ProtocolId":686,"Raw":null},
                  {"Name":"DirectionLeft","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x00DF2)():3","ProtocolId":686,"Raw":null},
                  {"Name":"DirectionRight","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x08D72)():3","ProtocolId":686,"Raw":null},
                  {"Name":"DirectionUp","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x02DD2)():3","ProtocolId":686,"Raw":null},
                  {"Name":"Info","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x043BC)():3","ProtocolId":686,"Raw":null},
                  {"Name":"Mute","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x08E71)():3","ProtocolId":686,"Raw":null},
                  {"Name":"Pause","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x051AE)():3","ProtocolId":686,"Raw":null},
                  {"Name":"Play","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x051AE)():3","ProtocolId":686,"Raw":null},
                  {"Name":"PowerToggle","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x00EF1)():3","ProtocolId":686,"Raw":null},
                  {"Name":"Select","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x051AE)():3","ProtocolId":686,"Raw":null},
                  {"Name":"SoundControl","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x0659A)():3","ProtocolId":686,"Raw":null},
                  {"Name":"SoundMode","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x0DE21)():3","ProtocolId":686,"Raw":null},
                  {"Name":"Source","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x0AE51)():3","ProtocolId":686,"Raw":null},
                  {"Name":"VolumeDown","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x01EE1)():3","ProtocolId":686,"Raw":null},
                  {"Name":"VolumeUp","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x0EE11)():3","ProtocolId":686,"Raw":null},
                  {"Name":"WakeUp","KeyCode":"G:Samsung 16 and 20 Bit:()(0x0CF0_1x009F6)():3","ProtocolId":686,"Raw":null}
                ]
              }
            }
            """.trimIndent()
        )
        val result = catalogRows(samsungPkg, blankHub)
        assertEquals(17, result.rows.size)
        assertEquals(0, result.skipped.size)
        assertEquals(listOf("Samsung 16 and 20 Bit"), result.protocolsUsed)
        assertTrue(result.missingProtocols.isEmpty())
        assertTrue(result.protocolsToAdd.isEmpty())
    }

    @Test
    fun `catalogRows accepts validly bundled protocols and missingProtocolsHint explains workarounds`() {
        val bundledPkg = Json.parseToJsonElement(
            """
            {
              "schema_version": "0.2.0",
              "resources": {
                "global_language_commands": [
                  {"Name":"PowerOn","KeyCode":"G:Fixture Custom 24 Bit:()(0x123456)():3","ProtocolId":777},
                  {"Name":"StillMissing","KeyCode":"G:Unknown Proto:()(0x1)():3","ProtocolId":888}
                ],
                "protocols": [
                  {
                    "__type": "IrProtocol",
                    "Id-": 777,
                    "Name": "Fixture Custom 24 Bit",
                    "CarrierFrequency": 38000,
                    "IRSegments": [{"Name":"Fixture Custom 24 Bit"}],
                    "CodeSegments": [],
                    "KeyCode": {"Start":null,"Repeat":[{"SegmentType":1,"SegmentName":"Fixture Custom 24 Bit"}],"Finish":null}
                  },
                  {"__type": "HidProtocol", "Id-": 999997, "Name": "HID 16 Bit"}
                ]
              }
            }
            """.trimIndent()
        )
        val result = catalogRows(bundledPkg, BUILTIN_HUB_PROTOCOLS)
        assertEquals(listOf("PowerOn"), result.rows.map { it.name })
        assertEquals(1, result.protocolsToAdd.size)
        assertEquals("Fixture Custom 24 Bit", (result.protocolsToAdd[0]["Name"] as JsonPrimitive).content)
        assertEquals(listOf("Unknown Proto"), result.missingProtocols)
        assertTrue(describeCatalogRows(result).contains("adds protocols: Fixture Custom 24 Bit"))
        val hint = missingProtocolsHint(result.missingProtocols)
        assertTrue(hint.contains("Unknown Proto"))
        assertTrue(hint.contains("original remote"))
        assertTrue(hint.contains("IRDB"))
        assertTrue(hint.contains("Flipper"))
        assertEquals("", missingProtocolsHint(emptyList()))
    }
}
