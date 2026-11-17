package app.melodious

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.service.quicksettings.TileService
import app.melodious.system.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class HubIntentTest {
    @Test fun onlyMelodiousHubLinksDispatch() {
        val actions = mutableListOf<String>()
        for (url in listOf("melodious://hub/poweroff", "melodious://hub/activity/42",
            "harmony://hub/poweroff", "melodious://elsewhere/poweroff", "melodious://hub/activity")) {
            dispatchHubLink(Uri.parse(url), { actions.add("off") }, { actions.add(it) })
        }
        assertEquals(listOf("off", "42"), actions)
    }

    @Test fun widgetActsOnTheRequestedActivityAndTileResolvesToPowerOff() {
        val context: Context = RuntimeEnvironment.getApplication()
        for (id in listOf("42", "-1")) {
            val intent = shadowOf(RemoteActionReceiver.runIntent(context, id)).savedIntent
            assertEquals(RemoteActionReceiver::class.java.name, intent.component?.className)
            assertEquals(RemoteActionReceiver.ACTION_RUN_ACTIVITY, intent.action)
            assertEquals(id, intent.getStringExtra(RemoteActionReceiver.EXTRA_ACTIVITY_ID))
        }
        val service = context.packageManager.resolveService(Intent(TileService.ACTION_QS_TILE).setPackage(context.packageName), 0)
        assertEquals(PowerOffTileService::class.java.name, service?.serviceInfo?.name)
    }
}
