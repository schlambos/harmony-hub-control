package app.melodious

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class HubHelpTest {
    @Test fun resendDelegatesDiffToEngineWithoutBlindPowerOrInputCommands() = runBlocking {
        val commands = mutableListOf<String>()
        requestHubHelp("42") { cmd, params, _ ->
            commands.add(cmd)
            assertEquals(Json.parseToJsonElement("""{"activityId":"42"}"""), params)
            null
        }
        assertEquals(listOf("harmony.engine?helpdiscretes"), commands)
    }
}
