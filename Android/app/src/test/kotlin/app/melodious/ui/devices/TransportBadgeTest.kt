package app.melodious.ui.devices

import app.melodious.protocol.model.HubDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TransportBadgeTest {

    @Test
    fun `hub Bluetooth device gets Bluetooth badge label`() {
        val device = HubDevice(
            id = "39000020",
            name = "Nvidia Shield",
            transport = 64,
            autoDetectedId = "melodious-bt-39000020",
        )
        assertTrue(device.isHubBluetooth)
        assertFalse(device.isHomeAssistant)
        assertEquals("Bluetooth", transportBadgeLabel(device))
    }

    @Test
    fun `other device transports keep their badge labels`() {
        assertEquals(
            "BLE Wake",
            transportBadgeLabel(
                HubDevice(id = "1", name = "Switch 2", transport = 64, autoDetectedId = "melodious-switch2-1"),
            ),
        )
        assertEquals(
            "BLE Wake",
            transportBadgeLabel(
                HubDevice(id = "2", name = "Switch 2", transport = 32, autoDetectedId = "melodious-switch2-2"),
            ),
        )
        assertEquals(
            "Bluetooth",
            transportBadgeLabel(HubDevice(id = "3", name = "Apple TV", transport = 32)),
        )
        assertEquals(
            "LG webOS",
            transportBadgeLabel(
                HubDevice(id = "4", name = "LG TV", transport = 64, autoDetectedId = "melodious-webos-4"),
            ),
        )
        assertEquals(
            "Home Assistant",
            transportBadgeLabel(
                HubDevice(id = "5", name = "Lamp", transport = 64, autoDetectedId = "melodious-ha-5"),
            ),
        )
        assertEquals(
            "Network",
            transportBadgeLabel(
                HubDevice(id = "6", name = "Sony TV", transport = 64, autoDetectedId = "melodious-androidtv-6"),
            ),
        )
        assertEquals(
            "IR",
            transportBadgeLabel(HubDevice(id = "7", name = "Receiver", transport = 1)),
        )
    }
}
