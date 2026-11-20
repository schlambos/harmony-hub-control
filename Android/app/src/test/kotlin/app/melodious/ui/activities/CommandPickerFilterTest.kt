package app.melodious.ui.activities

import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.HubDevice
import org.junit.Assert.assertEquals
import org.junit.Test

class CommandPickerFilterTest {

    private val devices = (0 until 20).map { i ->
        when (i) {
            0 -> HubDevice(
                id = "100",
                name = "TV LG",
                commands = listOf(DeviceCommand("VolumeUp", 1), DeviceCommand("Home", 2)),
            )
            15 -> HubDevice(
                id = "115",
                name = "Lampe salon",
                commands = listOf(DeviceCommand("PowerToggle", 10), DeviceCommand("Home", 11)),
            )
            else -> HubDevice(
                id = (100 + i).toString(),
                name = "Device ${i + 1}",
                commands = listOf(DeviceCommand("PowerOn", 20 + i)),
            )
        }
    }

    @Test
    fun `empty query returns only the active device commands unprefixed`() {
        val matches = filterPickerCommands(devices, "100", "")
        assertEquals(listOf("100:VolumeUp", "100:Home"), matches.map { "${it.device.id}:${it.label}" })
    }

    @Test
    fun `non-empty query shows active device first unprefixed and other devices prefixed`() {
        val matches = filterPickerCommands(devices, "100", "home")
        assertEquals(
            listOf("100:Home", "115:Lampe salon · Home"),
            matches.map { "${it.device.id}:${it.label}" },
        )
    }

    @Test
    fun `multi-word query matches device name and command across all devices`() {
        val matches = filterPickerCommands(devices, "100", "salon toggle")
        assertEquals(
            listOf("115:Lampe salon · PowerToggle"),
            matches.map { "${it.device.id}:${it.label}" },
        )
    }

    @Test
    fun `exclude filter still hides power and input commands when searching`() {
        val matches = filterPickerCommands(devices, "100", "power", exclude = { it.startsWith("Power") })
        assertEquals(emptyList<PickerCommandMatch>(), matches)
    }
}
