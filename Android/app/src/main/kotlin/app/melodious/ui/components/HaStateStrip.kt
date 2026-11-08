package app.melodious.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.protocol.model.HaChip
import app.melodious.protocol.model.HaDeviceInfo
import app.melodious.protocol.model.HubDevice
import app.melodious.ui.theme.MelodiousColors

/**
 * Live Home Assistant state for devices on the remote and device screens: power, input, app,
 * playing, volume and mute, plus an LG's ports. Unknown state says "State unknown", never "Off".
 * [single] drops the device name (a device's own page).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HaStateStrip(rows: List<Pair<HubDevice, HaDeviceInfo>>, modifier: Modifier = Modifier, single: Boolean = false) {
    if (rows.isEmpty()) return
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(MelodiousColors.Card)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .semantics { contentDescription = "Home Assistant device state" },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        rows.forEach { (device, info) ->
            Column(
                Modifier.semantics { contentDescription = "${device.name}: ${info.summary}" },
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (!single) {
                        Text(
                            device.name,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.align(Alignment.CenterVertically).padding(end = 4.dp),
                        )
                    }
                    info.chips.forEach { HaStateChip(it) }
                }
                info.theater?.portsText?.takeIf { it.isNotBlank() }?.let {
                    Text(it, fontSize = 12.sp, lineHeight = 18.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun HaStateChip(chip: HaChip) {
    val on = chip.kind == HaChip.Kind.ON
    val muted = chip.kind == HaChip.Kind.OFF || chip.kind == HaChip.Kind.UNKNOWN
    Row(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (on) MelodiousColors.Live.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHighest)
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        when (chip.kind) {
            HaChip.Kind.ON -> StatusDot(MelodiousColors.Live)
            HaChip.Kind.OFF -> StatusDot(MaterialTheme.colorScheme.outline)
            else -> Unit
        }
        Text(
            chip.label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = when {
                on -> MelodiousColors.Live
                muted -> MaterialTheme.colorScheme.onSurfaceVariant
                else -> Color.Unspecified
            },
        )
    }
}
