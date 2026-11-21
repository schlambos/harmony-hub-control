package app.melodious.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SettingsInputHdmi
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material.icons.filled.Speaker
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import app.melodious.protocol.model.HubActivity
import app.melodious.protocol.model.HubDevice

fun activityIcon(activity: HubActivity): ImageVector {
    val name = activity.name.lowercase()
    return when {
        name.contains("pc") || name.contains("computer") -> Icons.Filled.Computer
        activity.type == 1 -> Icons.Filled.Tv
        activity.type == 2 -> Icons.Filled.Movie
        activity.type == 3 -> Icons.Filled.SportsEsports
        activity.type == 4 -> Icons.Filled.MusicNote
        else -> Icons.Filled.PlayArrow
    }
}

/**
 * Loads an activity's own icon from the hub (docs/REMOTE_PICTURES.md); provided
 * at the app root by MelodiousViewModel.activityPicture. Without a provider,
 * tiles show the symbol for the activity's kind.
 */
val LocalActivityPictures = staticCompositionLocalOf<suspend (HubActivity) -> ImageBitmap?> { { null } }

/**
 * An activity's tile: its own icon when the hub holds one, else the symbol
 * from [activityIcon] (also while the picture loads).
 */
@Composable
fun ActivityTile(
    activity: HubActivity,
    container: Color,
    tint: Color,
    size: Int,
    modifier: Modifier = Modifier,
) {
    val loader = LocalActivityPictures.current
    val name = activity.imageName
    val picture by produceState<ImageBitmap?>(initialValue = null, name, loader) {
        value = if (name == null) null else runCatching { loader(activity) }.getOrNull()
    }
    val bitmap = picture
    if (bitmap == null) {
        IconTile(activityIcon(activity), modifier = modifier, container = container, tint = tint, size = size)
    } else {
        Image(
            bitmap = bitmap,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = modifier.size(size.dp).clip(RoundedCornerShape((size * 0.28f).dp)),
        )
    }
}

fun deviceIcon(device: HubDevice): ImageVector {
    val type = device.type.lowercase()
    val name = "${device.name} ${device.model}".lowercase()
    return when {
        STREAMER_HINTS.any { name.contains(it) } -> Icons.Filled.Cast
        type.contains("television") || type.contains("tv") || type.contains("projector") -> Icons.Filled.Tv
        type.contains("amplifier") || type.contains("receiver") || type.contains("sound") || type.contains("speaker") -> Icons.Filled.Speaker
        type.contains("game") || type.contains("console") -> Icons.Filled.SportsEsports
        type.contains("computer") || type.contains("pc") -> Icons.Filled.Computer
        type.contains("media") || type.contains("stream") -> Icons.Filled.Cast
        type.contains("switch") -> Icons.Filled.SettingsInputHdmi
        type.contains("camera") -> Icons.Filled.Videocam
        device.isBluetoothHid -> Icons.Filled.Bluetooth
        else -> Icons.Filled.Tv
    }
}

private val STREAMER_HINTS = listOf("shield", "google tv", "chromecast", "apple tv", "roku", "fire tv", "firestick")

/** Human labels for hub role types, phrased as the job a device does. */
object RoleLabels {
    val order = listOf(
        "DisplayActivityRole",
        "VolumeActivityRole",
        "PlayMovieActivityRole",
        "PlayGameActivityRole",
        "PlayMediaActivityRole",
        "ChannelChangingActivityRole",
        "KeyboardTextEntryActivityRole",
    )

    fun label(roleType: String): String = when (roleType) {
        "DisplayActivityRole" -> "Screen"
        "VolumeActivityRole" -> "Sound / volume"
        "PlayMovieActivityRole" -> "Plays movies & shows"
        "PlayGameActivityRole" -> "Plays games"
        "PlayMediaActivityRole" -> "Plays music"
        "ChannelChangingActivityRole" -> "Changes channels"
        "KeyboardTextEntryActivityRole" -> "Keyboard / typing"
        else -> roleType.removeSuffix("ActivityRole")
    }
}
