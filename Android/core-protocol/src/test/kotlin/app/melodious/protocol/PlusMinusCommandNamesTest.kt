package app.melodious.protocol

import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.RemoteLayout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * IRDB names a Samsung TV's volume and channel keys "VOLUME +", "VOLUME -", "CHANNEL +" and
 * "CHANNEL -"; a trailing + or - after a letter reads as up or down. Mirrors
 * tools/webui-sim/test/plus-minus-command-names.test.mjs.
 */
class PlusMinusCommandNamesTest {
    private fun aliases(label: String) = RemoteLayout.REMOTE_BUTTONS.first { it.label == label }.aliases

    @Test
    fun `trailing plus and minus read as up and down after a letter`() {
        assertEquals("volumeup", RemoteLayout.commandKey("VOLUME +"))
        assertEquals("volumedown", RemoteLayout.commandKey("VOLUME -"))
        assertEquals("channelup", RemoteLayout.commandKey("CHANNEL +"))
        assertEquals("chdown", RemoteLayout.commandKey("CH-"))
        assertEquals("", RemoteLayout.commandKey("-"))
        assertEquals("dash", RemoteLayout.commandKey("Dash"))
        assertEquals("hdmi1", RemoteLayout.commandKey("HDMI 1"))
    }

    @Test
    fun `IRDB Samsung names land on the Volume and Channel keys`() {
        val tv = listOf("POWER", "VOLUME +", "VOLUME -", "MUTE", "CHANNEL -", "CHANNEL +", "CH LIST")
            .mapIndexed { i, n -> DeviceCommand(name = n, functionId = i) }
        assertEquals("VOLUME +", RemoteLayout.matchCommand(tv, aliases("Volume up"))?.name)
        assertEquals("VOLUME -", RemoteLayout.matchCommand(tv, aliases("Volume down"))?.name)
        assertEquals("CHANNEL +", RemoteLayout.matchCommand(tv, aliases("Channel up"))?.name)
        assertEquals("CHANNEL -", RemoteLayout.matchCommand(tv, aliases("Channel down"))?.name)
    }
}
