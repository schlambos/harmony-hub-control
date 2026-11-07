package app.melodious.ui.remote

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.FastForward
import androidx.compose.material.icons.filled.FastRewind
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.TouchApp
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.MelodiousViewModel
import app.melodious.RemoteTarget
import app.melodious.ui.components.Haptics
import app.melodious.ui.components.SectionLabel
import app.melodious.ui.theme.MelodiousColors
import app.melodious.protocol.model.HubDevice
import app.melodious.protocol.model.SoftButton
import app.melodious.protocol.model.ResolvedButtonAction
import kotlin.math.abs

/**
 * Builds a controller whose identity only changes when the mapped keys change, so an in-progress
 * hold is never interrupted by unrelated state updates (send log, status polling).
 */
@Composable
fun rememberRemoteController(
    viewModel: MelodiousViewModel,
    target: RemoteTarget,
    keys: Map<String, ResolvedButtonAction>,
    haptics: Haptics,
): RemoteController {
    val currentTarget by rememberUpdatedState(target)
    return remember(keys, haptics) {
        RemoteController(
            keys = keys,
            haptics = haptics,
            press = { key, long -> viewModel.pressKey(currentTarget, key, long) },
            holdStart = { key -> viewModel.startHold(currentTarget, key) },
            holdEnd = { viewModel.stopHold() },
        )
    }
}

private fun menuLooksLikeHome(controller: RemoteController): Boolean = sendsHome(controller, "Menu")

/** Activities often map Menu or Exit to the streamer's Home; label the key by what it really does. */
private fun sendsHome(controller: RemoteController, key: String): Boolean =
    controller.keys[key]?.pressCommand?.contains("home", ignoreCase = true) == true

// ============================================================================
// Buttons
// ============================================================================

@Composable
fun ButtonsSurface(controller: RemoteController, onMoreKeys: () -> Unit, modifier: Modifier = Modifier) {
    val menuIsHome = menuLooksLikeHome(controller)
    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            IconKey(controller, "Rewind", "Rewind", Icons.Filled.FastRewind, Modifier.weight(1f).fillMaxHeight())
            IconKey(
                controller, "Play", "Play", Icons.Filled.PlayArrow, Modifier.weight(1f).fillMaxHeight(),
                container = MaterialTheme.colorScheme.primaryContainer,
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            IconKey(controller, "Pause", "Pause", Icons.Filled.Pause, Modifier.weight(1f).fillMaxHeight())
            IconKey(controller, "FastForward", "Fast forward", Icons.Filled.FastForward, Modifier.weight(1f).fillMaxHeight())
            MoreKeysButton(onMoreKeys, Modifier.weight(1f).fillMaxHeight())
        }

        DPad(controller, Modifier.fillMaxWidth().weight(1f))

        Row(
            Modifier.fillMaxWidth().height(176.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Rocker(controller, "VolumeUp", "VolumeDown", "VOL", "Volume up", "Volume down")
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CaptionKey(controller, BACK_KEY, "Back", Icons.AutoMirrored.Filled.Undo, Modifier.weight(1f).fillMaxHeight())
                    CaptionKey(
                        controller, "Menu", if (menuIsHome) "Home" else "Menu",
                        if (menuIsHome) Icons.Filled.Home else Icons.Filled.Menu,
                        Modifier.weight(1f).fillMaxHeight(),
                    )
                }
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    val exitIsHome = sendsHome(controller, "Exit") && !menuIsHome
                    CaptionKey(
                        controller, "Exit", if (exitIsHome) "Home" else "Exit",
                        if (exitIsHome) Icons.Filled.Home else Icons.AutoMirrored.Filled.ExitToApp,
                        Modifier.weight(1f).fillMaxHeight(),
                    )
                    CaptionKey(controller, "VolumeMute", "Mute", Icons.AutoMirrored.Filled.VolumeOff, Modifier.weight(1f).fillMaxHeight())
                }
            }
            Rocker(controller, "ChannelUp", "ChannelDown", "CH", "Channel up", "Channel down", useArrows = true)
        }
    }
}

@Composable
private fun MoreKeysButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(MelodiousColors.Key)
            .clickable(role = Role.Button, onClickLabel = "More keys", onClick = onClick)
            .semantics { contentDescription = "More keys" },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Filled.MoreHoriz, contentDescription = null)
    }
}

// ============================================================================
// Touchpad
// ============================================================================

@Composable
fun TouchpadSurface(controller: RemoteController, onMoreKeys: () -> Unit, modifier: Modifier = Modifier) {
    val menuIsHome = menuLooksLikeHome(controller)
    var lastGesture by remember { mutableStateOf<ImageVector?>(null) }
    var touching by remember { mutableStateOf(false) }
    val threshold = with(LocalDensity.current) { 36.dp.toPx() }

    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .clip(RoundedCornerShape(32.dp))
                .background(if (touching) Color(0xFF1B1F27) else MelodiousColors.Card)
                .border(1.dp, Color(0xFF262B34), RoundedCornerShape(32.dp))
                .semantics { contentDescription = "Touchpad. Swipe to move, tap for OK, long-press for menu." }
                .pointerInput(controller) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        touching = true
                        val start = down.uptimeMillis
                        var total = Offset.Zero
                        var direction: String? = null
                        var directionAt = 0L
                        var holding = false
                        var longFired = false
                        try {
                            while (true) {
                                val event = withTimeoutOrNull(40) { awaitPointerEvent() }
                                val now = SystemClock.uptimeMillis()
                                if (event != null) {
                                    val change = event.changes.firstOrNull { it.id == down.id } ?: event.changes.first()
                                    if (!change.pressed) {
                                        if (direction == null && !longFired) {
                                            lastGesture = Icons.Filled.TouchApp
                                            controller.fire("Select")
                                        }
                                        break
                                    }
                                    total += change.positionChange()
                                    change.consume()
                                    if (direction == null && !longFired && total.getDistance() > threshold) {
                                        val (key, icon) = when {
                                            abs(total.x) > abs(total.y) && total.x > 0 -> "DirectionRight" to Icons.Filled.KeyboardArrowRight
                                            abs(total.x) > abs(total.y) -> "DirectionLeft" to Icons.Filled.KeyboardArrowLeft
                                            total.y > 0 -> "DirectionDown" to Icons.Filled.KeyboardArrowDown
                                            else -> "DirectionUp" to Icons.Filled.KeyboardArrowUp
                                        }
                                        direction = key
                                        directionAt = now
                                        lastGesture = icon
                                        controller.fire(key)
                                    }
                                }
                                if (direction == null && !longFired && now - start > RemoteController.LONG_PRESS_MS) {
                                    longFired = true
                                    lastGesture = if (menuIsHome) Icons.Filled.Home else Icons.Filled.Menu
                                    controller.haptics.longPress()
                                    controller.fire("Menu")
                                }
                                if (direction != null && !holding && now - directionAt > RemoteController.HOLD_DELAY_MS) {
                                    holding = true
                                    controller.startHold(direction)
                                }
                            }
                        } finally {
                            if (holding) controller.endHold()
                            touching = false
                        }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(22.dp)) {
                Box(
                    Modifier.size(64.dp).clip(CircleShape).background(Color(0xFF1F2A44)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        lastGesture ?: Icons.Filled.TouchApp,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(28.dp),
                    )
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    GestureHint("Swipe", "move")
                    GestureHint("Tap", "OK")
                    GestureHint("Swipe & hold", "repeat")
                    GestureHint("Long-press", if (menuIsHome) "Home" else "Menu")
                }
            }
        }

        Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            KeyButton(controller, BACK_KEY, "Back", Modifier.weight(1f).fillMaxHeight()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Undo, contentDescription = null, modifier = Modifier.size(20.dp))
                    Text("Back", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                }
            }
            IconKey(
                controller, "Play", "Play", Icons.Filled.PlayArrow, Modifier.size(56.dp),
                container = MaterialTheme.colorScheme.primaryContainer,
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = RoundedCornerShape(20.dp),
            )
            IconKey(controller, "Pause", "Pause", Icons.Filled.Pause, Modifier.size(56.dp), shape = RoundedCornerShape(20.dp))
            MoreKeysButton(onMoreKeys, Modifier.size(56.dp))
        }

        Row(
            Modifier.fillMaxWidth().height(56.dp).clip(RoundedCornerShape(28.dp)).background(MelodiousColors.Key),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KeyButton(controller, "VolumeDown", "Volume down", Modifier.size(width = 72.dp, height = 56.dp), shape = RoundedCornerShape(28.dp)) {
                Text("−", fontSize = 26.sp)
            }
            KeyButton(controller, "VolumeMute", "Mute", Modifier.weight(1f).fillMaxHeight(), shape = RoundedCornerShape(0.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("VOLUME · tap to mute", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            KeyButton(controller, "VolumeUp", "Volume up", Modifier.size(width = 72.dp, height = 56.dp), shape = RoundedCornerShape(28.dp)) {
                Text("+", fontSize = 26.sp)
            }
        }
    }
}

@Composable
private fun GestureHint(gesture: String, action: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(gesture, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = Color(0xFFC3C8D2))
        Text("· $action", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ============================================================================
// Keyboard (Bluetooth HID via the hub)
// ============================================================================

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KeyboardSurface(
    keyboardReady: Boolean,
    onRefreshStatus: () -> Unit,
    haptics: Haptics,
    onSendText: (String) -> Unit,
    onSendKey: (String) -> Unit,
    onSetUpKeyboard: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var text by rememberSaveable { mutableStateOf("") }
    // The hub's keyboard often reconnects a little after the hub or TV wakes up. Re-check while this
    // tab is open and only call it a problem once it has had time to connect.
    var waitedLongEnough by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        val started = SystemClock.elapsedRealtime()
        while (true) {
            onRefreshStatus()
            kotlinx.coroutines.delay(3_000)
            if (SystemClock.elapsedRealtime() - started > KEYBOARD_GRACE_MS) waitedLongEnough = true
        }
    }
    val send = {
        if (text.isNotEmpty()) {
            haptics.tap()
            onSendText(text)
            text = ""
        }
    }
    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp).imePadding(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (!keyboardReady && !waitedLongEnough) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                androidx.compose.material3.CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Text("Connecting to the keyboard…", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else if (!keyboardReady) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(20.dp))
                    .background(Color(0xFF2E2718))
                    .padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = MelodiousColors.Warning)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("The hub's Bluetooth keyboard isn't connected", fontWeight = FontWeight.Medium)
                    Text(
                        "Typing still sends, but nothing will arrive until the keyboard is paired with your TV.",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = onSetUpKeyboard, modifier = Modifier.padding(top = 2.dp)) { Text("Set up keyboard") }
                }
            }
        }

        Text(
            "Type a search, password or URL. Use your phone keyboard's mic button to dictate.",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
            placeholder = { Text("Type here") },
            shape = RoundedCornerShape(20.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
        )
        Button(
            onClick = send,
            enabled = text.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
            Text("Send to TV", fontSize = 15.sp)
        }

        SectionLabel("Keys", color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf(
                "Enter" to "enter",
                "Backspace" to "backspace",
                "Space" to "space",
                "Tab" to "tab",
                "Esc" to "escape",
                "Home" to "home",
                // Consumer page (0x0C) keys: report ID 3, already declared by
                // the hub's btkeyboard descriptor.  Home/Back are what the
                // Chromecast with Google TV remote sends.
                "Home (TV)" to "achome",
                "Back (TV)" to "acback",
                "Menu (TV)" to "acmenu",
                "Search (TV)" to "acsearch",
                "Guide (TV)" to "acguide",
                "Info (TV)" to "acinfo",
                "Settings (TV)" to "acsettings",
                "Exit (TV)" to "acexit",
                "Voice (TV)" to "acvoice",
                "Quick settings (TV)" to "acpanel",
            ).forEach { (label, code) ->
                AssistChip(
                    onClick = { haptics.tap(); onSendKey(code) },
                    label = { Text(label) },
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
    }
}

// ============================================================================
// More keys bottom sheet
// ============================================================================

private const val KEYBOARD_GRACE_MS = 20_000L

/** Firmware ButtonKey for the remote's Back/Return key. */
private const val BACK_KEY = "PrevChannel"

private val SECONDARY_KEYS = listOf(
    "Guide" to "Guide", "Info" to "Info", "Dvr" to "DVR", "Exit" to "Exit",
)
private val NUMBER_KEYS = listOf(
    "Number1" to "1", "Number2" to "2", "Number3" to "3",
    "Number4" to "4", "Number5" to "5", "Number6" to "6",
    "Number7" to "7", "Number8" to "8", "Number9" to "9",
    "Dash" to "–", "Number0" to "0", "Enter" to "Enter",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoreKeysSheet(
    title: String,
    controller: RemoteController,
    devices: List<HubDevice>,
    onSendDeviceCommand: (deviceId: String, command: String) -> Unit,
    onDismiss: () -> Unit,
    softButtons: List<SoftButton> = emptyList(),
    onSoftButton: (SoftButton) -> Unit = {},
    onEditSoftButtons: (() -> Unit)? = null,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var showAllCommands by rememberSaveable { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        if (showAllCommands) {
            AllCommandsPage(
                devices = devices,
                haptics = controller.haptics,
                onBack = { showAllCommands = false },
                onSend = onSendDeviceCommand,
            )
        } else {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp).navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("More keys", fontSize = 20.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                    Text(title, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }

                val sheetKey = Color(0xFF262A33)
                val extras = softButtons.filter { it.digit == null }
                if (extras.isNotEmpty() || onEditSoftButtons != null) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("This activity", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp).weight(1f))
                        if (onEditSoftButtons != null) {
                            TextButton(onClick = onEditSoftButtons) { Text(if (extras.isEmpty()) "Add buttons" else "Edit") }
                        }
                    }
                }
                if (extras.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        extras.chunked(3).forEach { row ->
                            Row(Modifier.fillMaxWidth().height(52.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                row.forEach { button ->
                                    Box(
                                        Modifier
                                            .weight(1f)
                                            .fillMaxHeight()
                                            .clip(RoundedCornerShape(16.dp))
                                            .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f))
                                            .clickable(onClickLabel = "Send ${button.label}", role = Role.Button) {
                                                controller.haptics.tap()
                                                onSoftButton(button)
                                            }
                                            .padding(horizontal = 6.dp),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(button.label, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                                    }
                                }
                                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SECONDARY_KEYS.forEach { (key, label) ->
                        KeyButton(controller, key, label, Modifier.weight(1f).fillMaxHeight(), RoundedCornerShape(16.dp), container = sheetKey) {
                            Text(label, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    IconKey(controller, "Record", "Record", Icons.Filled.FiberManualRecord, Modifier.weight(1f).fillMaxHeight(), container = sheetKey, tint = Color(0xFFFF8A80))
                    IconKey(controller, "Stop", "Stop", Icons.Filled.Stop, Modifier.weight(1f).fillMaxHeight(), container = sheetKey)
                    ColorKey(controller, "Red", MelodiousColors.KeyRed, Modifier.weight(1f).fillMaxHeight())
                    ColorKey(controller, "Green", MelodiousColors.KeyGreen, Modifier.weight(1f).fillMaxHeight())
                    ColorKey(controller, "Yellow", MelodiousColors.KeyYellow, Modifier.weight(1f).fillMaxHeight())
                    ColorKey(controller, "Blue", MelodiousColors.KeyBlue, Modifier.weight(1f).fillMaxHeight())
                }

                if (NUMBER_KEYS.any { controller.isMapped(it.first) }) {
                    Text("Numbers", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        NUMBER_KEYS.chunked(3).forEach { row ->
                            Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                row.forEach { (key, label) ->
                                    KeyButton(controller, key, label, Modifier.weight(1f).fillMaxHeight(), RoundedCornerShape(16.dp), container = sheetKey) {
                                        Text(label, fontSize = if (label.length > 1) 15.sp else 22.sp)
                                    }
                                }
                            }
                        }
                    }
                }

                if (devices.isNotEmpty()) {
                    TextButton(onClick = { showAllCommands = true }, modifier = Modifier.align(Alignment.CenterHorizontally).heightIn(min = 48.dp)) {
                        Text("All device commands…")
                    }
                }
            }
        }
    }
}

@Composable
private fun AllCommandsPage(
    devices: List<HubDevice>,
    haptics: Haptics,
    onBack: () -> Unit,
    onSend: (deviceId: String, command: String) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val q = query.trim()
    Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f)) {
        Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            androidx.compose.material3.IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to keys")
            }
            Text("All commands", fontSize = 20.sp, fontWeight = FontWeight.Medium)
        }
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            placeholder = { Text("Search commands") },
            singleLine = true,
            shape = RoundedCornerShape(26.dp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        )
        LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
            devices.forEach { device ->
                val cmds = device.commands.filter { q.isEmpty() || it.name.contains(q, ignoreCase = true) }
                if (cmds.isEmpty()) return@forEach
                item(key = "h-${device.id}") {
                    Text(
                        device.name,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 4.dp),
                    )
                }
                items(cmds, key = { "${device.id}-${it.name}" }) { cmd ->
                    Text(
                        cmd.name,
                        fontSize = 16.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button) { haptics.tap(); onSend(device.id, cmd.name) }
                            .heightIn(min = 52.dp)
                            .padding(horizontal = 20.dp, vertical = 15.dp),
                    )
                }
            }
        }
    }
}
