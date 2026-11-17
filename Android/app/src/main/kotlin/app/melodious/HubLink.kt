package app.melodious

import android.net.Uri

internal fun dispatchHubLink(uri: Uri?, powerOff: () -> Unit, startActivity: (String) -> Unit) {
    if (uri?.scheme != "melodious" || uri.host != "hub") return
    val path = uri.pathSegments
    when (path.firstOrNull()) {
        "poweroff" -> powerOff()
        "activity" -> path.getOrNull(1)?.let(startActivity)
    }
}
