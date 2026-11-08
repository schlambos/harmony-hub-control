package app.melodious.protocol

import app.melodious.protocol.graph.ActivityGraphBuilder
import app.melodious.protocol.ir.IrProtocolTools
import app.melodious.protocol.model.ActivityWizardDraft
import app.melodious.protocol.model.ButtonMappingSource
import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.HubDevice
import app.melodious.protocol.model.RemoteLayout
import app.melodious.protocol.model.SkinPowerAction
import app.melodious.protocol.model.WizardButtonMapping
import app.melodious.protocol.model.WizardRoleDraft
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityGraphAndLayoutTest {

    @Test
    fun `RemoteLayout matches aliases and resolves skin power action`() {
        val commands = listOf(
            DeviceCommand(name = "PowerToggle", functionId = 101),
            DeviceCommand(name = "VolumeUp", functionId = 102),
            DeviceCommand(name = "DirectionUp", functionId = 103),
        )
        val matchedPower = RemoteLayout.matchCommand(commands, RemoteLayout.POWER_ALIASES)
        assertNotNull(matchedPower)
        assertEquals("PowerToggle", matchedPower?.name)

        // When in Activities mode and an activity is running, skin power triggers ActivityPowerOff
        val actPower = RemoteLayout.resolveSkinPowerAction(
            isActivitiesMode = true,
            currentActivityId = "48113644",
            selectedDeviceId = null,
            deviceCommands = emptyList(),
        )
        assertEquals(SkinPowerAction.ActivityPowerOff, actPower)

        // When everything is off in Activities mode, skin power is inert
        val offPower = RemoteLayout.resolveSkinPowerAction(
            isActivitiesMode = true,
            currentActivityId = "-1",
            selectedDeviceId = null,
            deviceCommands = emptyList(),
        )
        assertTrue(offPower is SkinPowerAction.Inert)
    }

    @Test
    fun `ActivityGraphBuilder allocates above cloud ID floors and preserves 16420 BT HID map`() {
        val fixtureJson = """
            {
              "revision": "rev-1",
              "activityList": {
                "Activities": [
                  {
                    "Id-": 48113644,
                    "Name": "NVIDIA Shield",
                    "ActivityDisplayName": "NVIDIA Shield",
                    "Type": 2,
                    "ActivityOrder": 0,
                    "Roles": []
                  }
                ]
              },
              "mapList": {
                "ButtonMaps": [
                  {
                    "ButtonMapId-": 50000001,
                    "ActivityId-": 48113644,
                    "__type": "ActivityButtonMap",
                    "ButtonMapIdentifier": "16414Activity48113644",
                    "Buttons": []
                  },
                  {
                    "ButtonMapId-": 50000002,
                    "ActivityId-": 48113644,
                    "__type": "ActivityButtonMap",
                    "ButtonMapIdentifier": "16420Activity48113644",
                    "Buttons": [
                      {
                        "ButtonId": 1500000001,
                        "ButtonKey": "Enter",
                        "ButtonState": 1,
                        "__type": "HardRemoteButton",
                        "ButtonAction": {
                          "DeviceId-": 7001,
                          "__type": "ButtonCommandAction",
                          "CommandName": "Select",
                          "EventType": 1,
                          "Id": 0
                        }
                      }
                    ]
                  }
                ]
              },
              "functionList": {
                "FunctionMaps": []
              },
              "deviceList": {
                "DevicesWithFeatures": [
                  {
                    "Device": {
                      "Id-": 7001,
                      "Name": "NVIDIA Shield",
                      "Transport": 32
                    },
                    "Commands": [
                      { "Name": "Select", "FunctionId-": 10 },
                      { "Name": "VolumeUp", "FunctionId-": 11 }
                    ]
                  }
                ]
              }
            }
        """.trimIndent()

        val root = Json.parseToJsonElement(fixtureJson).jsonObject
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(root)

        val draft = ActivityWizardDraft(
            editActivityId = "48113644",
            name = "NVIDIA Shield Updated",
            type = 2,
            roles = listOf(
                WizardRoleDraft(roleType = "PlayMovieActivityRole", deviceId = "7001"),
                WizardRoleDraft(roleType = "KeyboardTextEntryActivityRole", deviceId = "7001"),
            ),
            buttons = mapOf(
                "Select" to WizardButtonMapping(
                    deviceId = "7001",
                    commandName = "Select",
                    functionId = 10,
                    source = ButtonMappingSource.USER,
                )
            )
        )

        val built = ActivityGraphBuilder.buildActivityGraph(snapshot, draft)
        val maps = (built.mapList["ButtonMaps"] as JsonArray).map { it.jsonObject }

        // Both 16414 wizard map and 16420 Bluetooth HID map must survive!
        assertTrue(maps.any { it["ButtonMapIdentifier"]?.jsonPrimitive?.content == "16414Activity48113644" })
        assertTrue(maps.any { it["ButtonMapIdentifier"]?.jsonPrimitive?.content == "16420Activity48113644" })

        val wizMap = maps.first { it["ButtonMapIdentifier"]?.jsonPrimitive?.content == "16414Activity48113644" }
        val buttons = wizMap["Buttons"]!!.jsonArray
        assertEquals(1, buttons.size)
        val firstButtonId = buttons[0].jsonObject["ButtonId"]!!.jsonPrimitive.content.toInt()
        assertTrue("Allocated ButtonId must exceed BUTTON_ID_FLOOR", firstButtonId > ActivityGraphBuilder.BUTTON_ID_FLOOR)
    }

    @Test
    fun `IrProtocolTools converts learned Pronto hex and parses IRDB lines`() {
        val pronto = "0000 006D 0002 0002 0156 00AB 0016 0015 0016 0040 0016 05F7"
        val raw = IrProtocolTools.prontoToHubRaw(pronto)
        assertTrue(raw.startsWith("F"))
        assertTrue(raw.contains("P"))
        assertTrue(raw.contains("S"))

        val batch = IrProtocolTools.parseIrdbLines(
            """
            PowerOff|G:Toshiba 32 Bit:(0xE0E040BF)(Repeat)():3
            VolumeUp|raw|F9470P20D0S1068
            """.trimIndent()
        )
        assertEquals(2, batch.rows.size)
        assertEquals(0, batch.skipped)
        assertEquals("raw", batch.rows[1].mode)
    }

    @Test
    fun `parseDevices prefers the hub's DeviceTypeDisplayName over the numeric DeviceType`() {
        // Real hubs send DeviceType as a number (19 = Amplifier); UI icons and wizard role defaults need the name.
        val deviceList = Json.parseToJsonElement(
            """
            {"DevicesWithFeatures":[
              {"Device":{"Id-":1,"Name":"Nakamichi Amp","DeviceType":19,"DeviceTypeDisplayName":"Amplifier","Transport":1},"Commands":[]},
              {"Device":{"Id-":2,"Name":"Legacy","DeviceType":"Television","Transport":1},"Commands":[]}
            ]}
            """.trimIndent()
        ).jsonObject
        val devices = ActivityGraphBuilder.parseDevices(deviceList)
        assertEquals("Amplifier", devices[0].type)
        assertEquals("Television", devices[1].type)
    }

    @Test
    fun `extractCurrentActivityId reads codex_webui's escaped reply envelope`() {
        // Captured verbatim from GET /api/activity-state on a live hub running Watch TV.
        val raw = """{"ok":true,"reply":"{\"cmd\":\"harmony.engine?getCurrentActivity\",\"code\":200,\"msg\":\"OK\",\"data\":{\"result\":\"1878029666\"}}\n"}"""
        assertEquals("1878029666", app.melodious.protocol.rest.CodexHubRestClient.extractCurrentActivityId(raw))
        assertEquals("-1", app.melodious.protocol.rest.CodexHubRestClient.extractCurrentActivityId("""{"data":{"result":"-1"}}"""))
        assertEquals("", app.melodious.protocol.rest.CodexHubRestClient.extractCurrentActivityId("""{"ok":true}"""))
    }

    @Test
    fun `parseDevices reads real input names and FixIt maps them to commands`() {
        // Shape captured from a live hub: inputs live in DeviceFeatures, activities store InputName.
        val deviceList = Json.parseToJsonElement(
            """
            {"DevicesWithFeatures":[
              {"Device":{"Id-":74521691,"Name":"LG TV","DeviceTypeDisplayName":"Television","Transport":1},
               "Commands":[{"Name":"PowerOn","FunctionId-":1},{"Name":"PowerToggle","FunctionId-":2},{"Name":"InputHdmi2","FunctionId-":3},{"Name":"InputTv","FunctionId-":4}],
               "DeviceFeatures":[{"Inputs":[
                 {"InputName":"HDMI 2","InputOrder":2,"Actions":[{"IRCommandName":"InputHdmi2"}]},
                 {"InputName":"TV","InputOrder":1,"Actions":[{"IRCommandName":"InputTv"}]}]}]},
              {"Device":{"Id-":81897247,"Name":"Nakamichi Amp","DeviceTypeDisplayName":"Amplifier","Transport":1},
               "Commands":[{"Name":"PowerToggle","FunctionId-":5},{"Name":"InputHdmiArc","FunctionId-":6}]}
            ]}
            """.trimIndent()
        ).jsonObject
        val devices = ActivityGraphBuilder.parseDevices(deviceList)
        assertEquals(listOf("TV", "HDMI 2"), devices[0].inputs)
        assertEquals(listOf("HdmiArc"), devices[1].inputs)

        val activity = app.melodious.protocol.model.HubActivity(
            id = "1", name = "Watch TV", displayName = "Watch TV",
            roles = listOf(
                app.melodious.protocol.model.HubRole(deviceId = "74521691", roleType = "DisplayActivityRole", selectedInput = "HDMI 2"),
                app.melodious.protocol.model.HubRole(deviceId = "81897247", roleType = "VolumeActivityRole", selectedInput = "HDMI Arc", powerOnOrder = 2),
            ),
        )
        val fixes = app.melodious.protocol.model.FixIt.devicesFor(activity, devices, roleLabel = { it })
        assertEquals("PowerOn", fixes[0].powerOn?.name)
        assertEquals("InputHdmi2", fixes[0].inputCommand?.name)
        assertEquals(null, fixes[1].powerOn)
        assertEquals("PowerToggle", fixes[1].powerToggle?.name)
        assertEquals("InputHdmiArc", fixes[1].inputCommand?.name)
    }

    @Test
    fun `state poll reads activity and status from the escaped digest`() {
        // Trimmed from a live GET /api/state while Watch TV was running.
        val reply = """"{\"cmd\":\"connect.statedigest?get\",\"code\":200,\"data\":{\"activityId\":\"1878029666\",\"stateVersion\":87,\"activityStatus\":2}}\n""""
        assertEquals("1878029666", app.melodious.protocol.rest.CodexHubRestClient.extractCurrentActivityId(reply))
        assertEquals(2, app.melodious.protocol.rest.CodexHubRestClient.extractActivityStatus(reply))
        assertEquals("87", app.melodious.protocol.rest.CodexHubRestClient.extractStateVersion(reply))
    }

    @Test
    fun `Back key uses the firmware's PrevChannel ButtonKey`() {
        // Real hubs store the physical Back/Return key as PrevChannel; the app must read and write that name.
        assertEquals("PrevChannel", RemoteLayout.BUTTON_KEY_BY_LABEL["Back"])
        val roles = listOf(WizardRoleDraft("PlayMovieActivityRole", "1"))
        val devices = listOf(HubDevice(id = "1", name = "Google TV", commands = listOf(DeviceCommand("Back", 7))))
        assertEquals("Back", ActivityGraphBuilder.deriveDefaultButtons(roles, devices)["PrevChannel"]?.commandName)
    }

    @Test
    fun `soft buttons come from the activity's 16417 map in menu order`() {
        val root = Json.parseToJsonElement(
            """
            {"revision":"r","activityList":{"Activities":[]},"functionList":{},
             "deviceList":{"DevicesWithFeatures":[{"Device":{"Id-":9,"Name":"Google TV"},"Commands":[]}]},
             "mapList":{"ButtonMaps":[{"ActivityId-":5,"ButtonMapIdentifier":"16417Activity5","__type":"ActivityButtonMap","Buttons":[
               {"__type":"SoftRemoteButton","TextOnRemote":"Sleep","MenuItem":{"IndexInMenu":16},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"Sleep","FunctionId-":145}},
               {"__type":"SoftRemoteButton","TextOnRemote":"123","MenuItem":{"IndexInMenu":0},"ButtonAction":{"__type":"ButtonClientAction","ActionName":"Numpad"}},
               {"__type":"SoftRemoteButton","TextOnRemote":"PreviousTrack","MenuItem":{"IndexInMenu":1},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"PreviousTrack"}},
               {"__type":"SoftRemoteButton","TextOnRemote":"7","MenuItem":{"IndexInMenu":6},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"7"}},
               {"__type":"HardRemoteButton","ButtonKey":"Menu","ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"Menu"}}
             ]}]}}
            """.trimIndent()
        ).jsonObject
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(root)
        val soft = ActivityGraphBuilder.resolveActivitySoftButtons(snapshot, "5")
        assertEquals(listOf("Previous Track", "7", "Sleep"), soft.map { it.label })
        assertEquals(7, soft[1].digit)
        assertEquals("Google TV", soft[2].deviceName)
        assertEquals("F10", ActivityGraphBuilder.humanizeLabel("F10"))
    }

    @Test
    fun `sleep timer is read from the digest as seconds remaining on the hub clock`() {
        val running = """"{\"data\":{\"sleepTimerId\":1,\"sleepTimerValue\":1792580000,\"time\":1792578200}}""""
        val timer = app.melodious.protocol.rest.CodexHubRestClient.extractSleepTimer(running)
        assertEquals(1800L, timer?.secondsRemaining)
        assertTrue(timer!!.isRunning)
        val off = """"{\"data\":{\"sleepTimerId\":-1,\"time\":1792578200}}""""
        assertFalse(app.melodious.protocol.rest.CodexHubRestClient.extractSleepTimer(off)!!.isRunning)
    }

    @Test
    fun `touch screen edits keep hard keys, number pad and client buttons and round-trip sequences`() {
        val root = Json.parseToJsonElement(
            """
            {"revision":"r","activityList":{"Activities":[{"Id-":5,"Name":"Watch TV","Roles":[]}]},"functionList":{"FunctionMaps":[]},
             "deviceList":{"DevicesWithFeatures":[{"Device":{"Id-":9,"Name":"Google TV"},"Commands":[{"Name":"Home","FunctionId-":195}]}]},
             "mapList":{"ButtonMaps":[
              {"ButtonMapId-":52944093,"ActivityId-":5,"ButtonMapIdentifier":"16417Activity5","SurfaceId-":14551427,"ButtonMapSurfaceId-":14551427,"RemoteId-":10000001,"__type":"ActivityButtonMap","Sequences":[],"Buttons":[
               {"__type":"HardRemoteButton","ButtonKey":"Menu","ButtonId":1878029800,"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"Menu"}},
               {"__type":"SoftRemoteButton","FunctionGroupType":2,"ButtonId":1878029801,"TextOnRemote":"7","MenuItem":{"IndexInMenu":6},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"7"}},
               {"__type":"SoftRemoteButton","FunctionGroupType":36,"ButtonId":1878029802,"TextOnRemote":"123","MenuItem":{"IndexInMenu":0},"ButtonAction":{"__type":"ButtonClientAction","ActionName":"Numpad"}},
               {"__type":"SoftRemoteButton","FunctionGroupType":0,"ButtonId":1878029803,"TextOnRemote":"Home","ImageId-":4,"MenuItem":{"IndexInMenu":1},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"Home","FunctionId-":195}}
              ]},
              {"ButtonMapId-":52944094,"ActivityId-":6,"ButtonMapIdentifier":"16414Activity6","__type":"ActivityButtonMap","Buttons":[]}
             ]}}
            """.trimIndent()
        ).jsonObject
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(root)
        val graph = app.melodious.protocol.graph.TouchScreenGraph
        val read = graph.read(snapshot, "5")
        assertEquals(listOf("Home"), read.buttons.map { it.label })

        val seq = app.melodious.protocol.graph.SequenceDraft(
            key = "new-1", name = "Netflix",
            steps = listOf(
                app.melodious.protocol.graph.SequenceStep.Command("9", "Home", 195),
                app.melodious.protocol.graph.SequenceStep.Delay(1.5),
                app.melodious.protocol.graph.SequenceStep.Command("9", "Select"),
            ),
        )
        val draft = read.copy(
            buttons = listOf(
                app.melodious.protocol.graph.SoftButtonDraft("Netflix", app.melodious.protocol.graph.SoftButtonAction.RunSequence("new-1")),
                read.buttons[0].copy(label = "Go home"),
            ),
            sequences = listOf(seq),
        )
        val built = graph.build(snapshot, draft)
        val maps = built.mapList["ButtonMaps"]!!.jsonArray.map { it.jsonObject }
        val touch = maps.first { it["ButtonMapIdentifier"]!!.jsonPrimitive.content == "16417Activity5" }
        val buttons = touch["Buttons"]!!.jsonArray.map { it.jsonObject }
        // Hard key, number-pad digit and the Touch's 123 toggle are untouched.
        assertTrue(buttons.any { it["ButtonKey"]?.jsonPrimitive?.content == "Menu" })
        assertTrue(buttons.any { it["TextOnRemote"]?.jsonPrimitive?.content == "7" })
        assertTrue(buttons.any { it["TextOnRemote"]?.jsonPrimitive?.content == "123" })
        // P06 #5 fixed slots: existing buttons keep their IndexInMenu (Go home stays at 1);
        // new buttons take the lowest free slot (Netflix gets 2, since 0 is owned by 123).
        // Saving never renumbers.
        val renamed = buttons.first { it["TextOnRemote"]?.jsonPrimitive?.content == "Go home" }
        assertEquals("1878029803", renamed["ButtonId"]!!.jsonPrimitive.content)
        assertEquals("4", renamed["ImageId-"]!!.jsonPrimitive.content)
        assertEquals(1, renamed["MenuItem"]!!.jsonObject["IndexInMenu"]!!.jsonPrimitive.content.toInt())
        val netflix = buttons.first { it["TextOnRemote"]?.jsonPrimitive?.content == "Netflix" }
        assertEquals(2, netflix["MenuItem"]!!.jsonObject["IndexInMenu"]!!.jsonPrimitive.content.toInt())
        val slots = buttons.filter { it["TextOnRemote"]?.jsonPrimitive?.content in setOf("Netflix", "Go home") }
            .map { it["MenuItem"]!!.jsonObject["IndexInMenu"]!!.jsonPrimitive.content.toInt() }
        assertEquals(listOf(2, 1), slots)
        // The other activity's map is unchanged.
        assertEquals(maps.first { it["ButtonMapIdentifier"]!!.jsonPrimitive.content == "16414Activity6" }, root["mapList"]!!.jsonObject["ButtonMaps"]!!.jsonArray[1])

        val reread = graph.read(ActivityGraphBuilder.parseConfigSnapshot(JsonObject(root.toMutableMap().apply { put("mapList", built.mapList) })), "5")
        // Reread sorts by slot: Go home (slot 1) comes before Netflix (slot 2).
        assertEquals(listOf("Go home", "Netflix"), reread.buttons.map { it.label })
        assertEquals(1, reread.sequences.size)
        assertEquals(seq.steps, reread.sequences[0].steps)
        val action = reread.buttons.first { it.label == "Netflix" }.action as app.melodious.protocol.graph.SoftButtonAction.RunSequence
        assertEquals(reread.sequences[0].key, action.sequenceKey)
    }

    @Test
    fun `activity save writes chosen power orders and start-end steps, keeping steps it can't edit`() {
        val root = Json.parseToJsonElement(
            """
            {"revision":"r","functionList":{"FunctionMaps":[]},"mapList":{"ButtonMaps":[]},
             "deviceList":{"DevicesWithFeatures":[
               {"Device":{"Id-":1,"Name":"TV"},"Commands":[{"Name":"Netflix"}]},
               {"Device":{"Id-":2,"Name":"Amp"},"Commands":[]},
               {"Device":{"Id-":3,"Name":"Streamer"},"Commands":[]}]},
             "activityList":{"Activities":[{"Id-":5,"Name":"Watch TV","Type":1,"ActivityOrder":0,
               "EnterActions":[{"__type":"ChannelActivityAction","ActionOrder":0,"ChannelNumber":"7"}],
               "LeaveActions":[],
               "Roles":[
                 {"Id-":11,"DeviceId-":1,"__type":"DisplayActivityRole","PowerOnOrder":0,"PowerOffOrder":0},
                 {"Id-":12,"DeviceId-":2,"__type":"VolumeActivityRole","PowerOnOrder":1,"PowerOffOrder":1},
                 {"Id-":13,"DeviceId-":3,"__type":"PlayMovieActivityRole","PowerOnOrder":2,"PowerOffOrder":2}]}]}}
            """.trimIndent()
        ).jsonObject
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(root)
        val raw = snapshot.activityList["Activities"]!!.jsonArray[0].jsonObject
        // A channel step can't be shown in the editor, so the list is left alone (null).
        assertEquals(null, ActivityGraphBuilder.parseActivityActions(raw["EnterActions"]))

        val roles = listOf(
            WizardRoleDraft("DisplayActivityRole", "1"),
            WizardRoleDraft("VolumeActivityRole", "2", powerDelay = 1500),
            WizardRoleDraft("PlayMovieActivityRole", "3"),
        )
        val leave = listOf(
            app.melodious.protocol.graph.SequenceStep.Command("1", "Netflix"),
            app.melodious.protocol.graph.SequenceStep.Delay(2.0),
        )
        val draft = ActivityWizardDraft(
            editActivityId = "5", name = "Watch TV", type = 1, roles = roles,
            powerOnOrder = listOf("3", "1", "2"), powerOffOrder = listOf("2", "3", "1"),
            enterSteps = null, leaveSteps = leave,
        )
        val built = ActivityGraphBuilder.buildActivityGraph(snapshot, draft)
        val activity = built.activityList["Activities"]!!.jsonArray[0].jsonObject
        val rolesOut = activity["Roles"]!!.jsonArray.map { it.jsonObject }
        fun order(dev: String, key: String) = rolesOut.first { it["DeviceId-"]!!.jsonPrimitive.content == dev }[key]!!.jsonPrimitive.content.toInt()
        assertEquals(listOf(2, 3, 1), listOf("1", "2", "3").map { order(it, "PowerOnOrder") })
        assertEquals(listOf(3, 1, 2), listOf("1", "2", "3").map { order(it, "PowerOffOrder") })
        assertEquals("1500", rolesOut.first { it["DeviceId-"]!!.jsonPrimitive.content == "2" }["NextDevicePowerOnDelay"]!!.jsonPrimitive.content)
        // Untouched enter list survives byte-for-byte; the leave list round-trips.
        assertEquals(raw["EnterActions"], activity["EnterActions"])
        assertEquals(leave, ActivityGraphBuilder.parseActivityActions(activity["LeaveActions"]))
        assertEquals(listOf("0", "1"), activity["LeaveActions"]!!.jsonArray.map { it.jsonObject["ActionOrder"]!!.jsonPrimitive.content })
    }

    @Test
    fun `new activity powers on by job priority with default waits`() {
        val root = Json.parseToJsonElement(
            """
            {"revision":"r","functionList":{"FunctionMaps":[]},"mapList":{"ButtonMaps":[]},
             "deviceList":{"DevicesWithFeatures":[
               {"Device":{"Id-":1,"Name":"TV"},"Commands":[]},
               {"Device":{"Id-":2,"Name":"Amp"},"Commands":[]},
               {"Device":{"Id-":3,"Name":"Streamer"},"Commands":[]}]},
             "activityList":{"Activities":[]}}
            """.trimIndent()
        ).jsonObject
        // Jobs added player-first: the saved order must still be TV, amp, player.
        val draft = ActivityWizardDraft(
            name = "Movie", type = 2,
            roles = listOf(
                WizardRoleDraft("PlayMovieActivityRole", "3"),
                WizardRoleDraft("VolumeActivityRole", "2"),
                WizardRoleDraft("DisplayActivityRole", "1"),
            ),
        )
        val built = ActivityGraphBuilder.buildActivityGraph(ActivityGraphBuilder.parseConfigSnapshot(root), draft)
        val rolesOut = built.activityList["Activities"]!!.jsonArray[0].jsonObject["Roles"]!!.jsonArray.map { it.jsonObject }
        fun field(dev: String, key: String) =
            rolesOut.first { it["DeviceId-"]!!.jsonPrimitive.content == dev }[key]!!.jsonPrimitive.content
        assertEquals(listOf("1", "2", "3"), listOf("1", "2", "3").map { field(it, "PowerOnOrder") })
        assertEquals(listOf("2500", "1500", "1000"), listOf("1", "2", "3").map { field(it, "NextDevicePowerOnDelay") })
    }

    @Test
    fun `editing keeps custom power order and waits, zero and unset included`() {
        val root = Json.parseToJsonElement(
            """
            {"revision":"r","functionList":{"FunctionMaps":[]},"mapList":{"ButtonMaps":[]},
             "deviceList":{"DevicesWithFeatures":[
               {"Device":{"Id-":1,"Name":"TV"},"Commands":[]},
               {"Device":{"Id-":2,"Name":"Amp"},"Commands":[]},
               {"Device":{"Id-":3,"Name":"Streamer"},"Commands":[]}]},
             "activityList":{"Activities":[{"Id-":5,"Name":"Watch TV","Type":1,"ActivityOrder":0,
               "EnterActions":[],"LeaveActions":[],
               "Roles":[
                 {"Id-":11,"DeviceId-":3,"__type":"PlayMovieActivityRole","PowerOnOrder":1,"PowerOffOrder":1,"NextDevicePowerOnDelay":0},
                 {"Id-":12,"DeviceId-":1,"__type":"DisplayActivityRole","PowerOnOrder":2,"PowerOffOrder":2},
                 {"Id-":13,"DeviceId-":2,"__type":"VolumeActivityRole","PowerOnOrder":3,"PowerOffOrder":3,"NextDevicePowerOnDelay":7000}]}]}}
            """.trimIndent()
        ).jsonObject
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(root)
        val activity = snapshot.activities.single()
        // The draft the editor builds from the hub's activity, untouched.
        val draft = ActivityWizardDraft(
            editActivityId = "5", name = "Watch TV", type = 1,
            roles = activity.roles.map {
                WizardRoleDraft(it.roleType, it.deviceId, it.selectedInput, it.nextDevicePowerOnDelay)
            },
            powerOnOrder = activity.roles.sortedBy { it.powerOnOrder }.map { it.deviceId }.distinct(),
            powerOffOrder = activity.roles.sortedBy { it.powerOffOrder }.map { it.deviceId }.distinct(),
        )
        val built = ActivityGraphBuilder.buildActivityGraph(snapshot, draft)
        val rolesOut = built.activityList["Activities"]!!.jsonArray[0].jsonObject["Roles"]!!.jsonArray.map { it.jsonObject }
        fun role(dev: String) = rolesOut.first { it["DeviceId-"]!!.jsonPrimitive.content == dev }
        assertEquals("1", role("3")["PowerOnOrder"]!!.jsonPrimitive.content)
        assertEquals("2", role("1")["PowerOnOrder"]!!.jsonPrimitive.content)
        assertEquals("3", role("2")["PowerOnOrder"]!!.jsonPrimitive.content)
        assertEquals("0", role("3")["NextDevicePowerOnDelay"]!!.jsonPrimitive.content)
        assertEquals(kotlinx.serialization.json.JsonNull, role("1")["NextDevicePowerOnDelay"])
        assertEquals("7000", role("2")["NextDevicePowerOnDelay"]!!.jsonPrimitive.content)
    }

    @Test
    fun `device settings read the hub's power feature and build the hub's request`() {
        // Shapes from a live hub: Google TV powers on with Home and off with Sleep; the amp is toggle-only.
        val list = Json.parseToJsonElement(
            """
            {"DevicesWithFeatures":[
              {"Device":{"Id-":66690268,"Name":"Google TV","InterKeyDelay":0,"InterDeviceDelay":300,"PressMinRepeats":3,"DeviceTypeDisplayName":"GameConsoleWithDvd"},
               "Commands":[{"Name":"Home"},{"Name":"Sleep"},{"Name":"PowerOn"}],
               "DeviceFeatures":[{"__type":"PowerFeature","PowerTypeId":1,"PowerOnDelay":1500,"IsPowerAlwaysOn":false,"IsPoweredOnBetweenActivities":false,
                 "PowerOnActions":[{"__type":"IRPressAction","IRCommandName":"Home"}],"PowerOffActions":[{"__type":"IRPressAction","IRCommandName":"Sleep"}]}]},
              {"Device":{"Id-":81897247,"Name":"Nakamichi Amp","DeviceTypeDisplayName":"Amplifier"},
               "Commands":[{"Name":"PowerToggle"}],
               "DeviceFeatures":[{"__type":"PowerFeature","PowerTypeId":2,"PowerToggleActions":[{"__type":"IRPressAction","IRCommandName":"PowerToggle"}]}]},
              {"Device":{"Id-":5,"Name":"New TV","DeviceTypeDisplayName":"Television"},
               "Commands":[{"Name":"Power On"},{"Name":"Power Off"}]}
            ]}
            """.trimIndent()
        ).jsonObject
        val entries = list["DevicesWithFeatures"]!!.jsonArray.map { it.jsonObject }
        val gtv = app.melodious.protocol.model.DeviceSettingsModel.read(entries[0])
        assertEquals(app.melodious.protocol.model.PowerType.DISCRETE, gtv.powerType)
        assertEquals("Home" to "Sleep", gtv.powerOn to gtv.powerOff)
        assertEquals(1500, gtv.powerOnDelayMs)
        assertEquals(0, gtv.interKeyDelayMs)
        val amp = app.melodious.protocol.model.DeviceSettingsModel.read(entries[1])
        assertEquals(app.melodious.protocol.model.PowerType.TOGGLE, amp.powerType)
        assertEquals(3, amp.repeats) // missing PressMinRepeats means the engine's default of 3
        // No power feature yet: suggest by command name, TVs default to a 10 s warm-up.
        val fresh = app.melodious.protocol.model.DeviceSettingsModel.read(entries[2])
        assertFalse(fresh.hasPowerFeature)
        assertEquals("Power On" to "Power Off", fresh.powerOn to fresh.powerOff)
        assertEquals(10000, fresh.powerOnDelayMs)

        val names = app.melodious.protocol.model.DeviceSettingsModel.commandNames(entries[0])
        assertTrue(app.melodious.protocol.model.DeviceSettingsModel.validate(gtv, names).isEmpty())
        assertEquals(1, app.melodious.protocol.model.DeviceSettingsModel.validate(gtv.copy(powerOff = "Home"), names).size)
        assertEquals(1, app.melodious.protocol.model.DeviceSettingsModel.validate(gtv.copy(repeats = 11), names).size)

        val body = app.melodious.protocol.model.DeviceSettingsModel.requestBody("66690268", gtv)
        assertEquals("deviceId", body.keys.first())
        val power = body["settings"]!!.jsonObject["power"]!!.jsonObject
        assertEquals("discrete", power["type"]!!.jsonPrimitive.content)
        assertEquals("Home", power["on"]!!.jsonPrimitive.content)
        assertEquals(kotlinx.serialization.json.JsonNull, power["toggle"])

        // Fix it follows the configured power commands instead of guessing from names.
        val devices = ActivityGraphBuilder.parseDevices(list)
        val activity = app.melodious.protocol.model.HubActivity("1", "Watch TV", "Watch TV",
            roles = listOf(app.melodious.protocol.model.HubRole(deviceId = "66690268", roleType = "PlayMovieActivityRole")))
        val fix = app.melodious.protocol.model.FixIt.devicesFor(activity, devices, roleLabel = { r: String -> r }, powerOverrides = mapOf("66690268" to gtv)).single()
        assertEquals("Home", fix.powerOn?.name)
    }

    private fun seededFixtureJson(): JsonObject {
        val digits = (0..9).joinToString(",") { """{ "Name": "$it", "FunctionId-": ${20 + it} }""" }
        return Json.parseToJsonElement("""
            {
              "revision": "rev-1",
              "activityList": { "Activities": [ { "Id-": 100, "Name": "Old", "ActivityOrder": 0, "Roles": [] } ] },
              "mapList": { "ButtonMaps": [
                { "ButtonMapId-": 50000001, "ActivityId-": 100, "__type": "ActivityButtonMap",
                  "ButtonMapIdentifier": "16414Activity100", "Buttons": [] },
                { "ButtonMapId-": 52944100, "ActivityId-": 100, "__type": "ActivityButtonMap",
                  "ButtonMapIdentifier": "16417Activity100", "SurfaceId-": 14551427,
                  "ButtonMapSurfaceId-": 14551427, "RemoteId-": 15390924, "Buttons": [
                    { "ButtonId": 1878030001, "ButtonKey": "Play", "ButtonState": 1, "__type": "HardRemoteButton",
                      "ButtonAction": { "DeviceId-": 7001, "__type": "ButtonCommandAction", "CommandName": "Play", "EventType": 1, "Id": 0 } }
                  ] }
              ] },
              "functionList": { "FunctionMaps": [] },
              "deviceList": { "DevicesWithFeatures": [
                { "Device": { "Id-": 7001, "Name": "Google TV", "Transport": 64 },
                  "Commands": [ { "Name": "Select", "FunctionId-": 10 }, { "Name": "Home", "FunctionId-": 12 }, $digits ] }
              ] }
            }
        """.trimIndent()).jsonObject
    }

    private fun seededDraft(edit: String? = null) = ActivityWizardDraft(
        editActivityId = edit,
        name = "Seeded",
        type = 1,
        roles = listOf(WizardRoleDraft(roleType = "PlayMovieActivityRole", deviceId = "7001")),
        buttons = buildMap {
            put("Select", WizardButtonMapping(deviceId = "7001", commandName = "Select", functionId = 10))
            for (n in 1..9) put("Number$n", WizardButtonMapping(deviceId = "7001", commandName = "$n", functionId = 20 + n))
            put("Number0", WizardButtonMapping(deviceId = "7001", commandName = "0", functionId = 20))
        },
    )

    @Test
    fun `a new activity seeds the Touch number pad and a Home button`() {
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(seededFixtureJson())
        val built = ActivityGraphBuilder.buildActivityGraph(snapshot, seededDraft())
        val id = built.activityId
        val touch = (built.mapList["ButtonMaps"] as JsonArray).map { it.jsonObject }
            .first { it["ButtonMapIdentifier"]?.jsonPrimitive?.content == "16417Activity$id" }
        val soft = touch["Buttons"]!!.jsonArray.map { it.jsonObject }
            .filter { it["__type"]?.jsonPrimitive?.content == "SoftRemoteButton" }
        val pad = soft.filter { it["FunctionGroupType"]?.jsonPrimitive?.int == 2 }
        assertEquals(
            listOf(
                0 to "1", 1 to "2", 2 to "3", 3 to "4", 4 to "5",
                5 to "6", 6 to "7", 7 to "8", 8 to "9", 10 to "0",
            ),
            pad.map {
                it["MenuItem"]!!.jsonObject["IndexInMenu"]!!.jsonPrimitive.int to
                    it["TextOnRemote"]!!.jsonPrimitive.content
            },
        )
        assertTrue(pad.all { it["ButtonAction"]!!.jsonObject["CommandName"]!!.jsonPrimitive.content == it["TextOnRemote"]!!.jsonPrimitive.content })
        assertTrue(pad.all { it["ButtonAction"]!!.jsonObject["DeviceId-"]!!.jsonPrimitive.int == 7001 })
        val onScreen = soft.filter { it["FunctionGroupType"]?.jsonPrimitive?.int == 0 }
        assertEquals(1, onScreen.size)
        assertEquals("Home", onScreen[0]["TextOnRemote"]!!.jsonPrimitive.content)
        assertEquals("Home", onScreen[0]["ButtonAction"]!!.jsonObject["CommandName"]!!.jsonPrimitive.content)
        assertEquals(7001, onScreen[0]["ButtonAction"]!!.jsonObject["DeviceId-"]!!.jsonPrimitive.int)
    }

    @Test
    fun `an edited activity is never reseeded`() {
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(seededFixtureJson())
        val built = ActivityGraphBuilder.buildActivityGraph(snapshot, seededDraft(edit = "100"))
        val touch = (built.mapList["ButtonMaps"] as JsonArray).map { it.jsonObject }
            .first { it["ButtonMapIdentifier"]?.jsonPrimitive?.content == "16417Activity100" }
        assertTrue(
            touch["Buttons"]!!.jsonArray.map { it.jsonObject }
                .none { it["__type"]?.jsonPrimitive?.content == "SoftRemoteButton" },
        )
    }
}
