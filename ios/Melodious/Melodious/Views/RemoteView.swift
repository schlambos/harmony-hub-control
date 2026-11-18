import SwiftUI

public struct RemoteView: View {
    @ObservedObject public var viewModel: HubViewModel
    public var isRegularWidth: Bool = false
    public var onNavigateToSettings: (() -> Void)?

    @State private var showMoreKeysSheet: Bool = false
    @State private var showNumpadInline: Bool = false

    public init(
        viewModel: HubViewModel,
        isRegularWidth: Bool = false,
        onNavigateToSettings: (() -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.isRegularWidth = isRegularWidth
        self.onNavigateToSettings = onNavigateToSettings
    }

    public var body: some View {
        ZStack {
            MelodiousTheme.canvas.ignoresSafeArea()

            if !viewModel.connectionStatus.isConnected && viewModel.configSnapshot == nil {
                disconnectedPlaceholder
            } else if let pendingId = viewModel.pendingActivityId {
                busySwitchingView(pendingId: pendingId)
            } else if let activity = viewModel.displayedActivity {
                activeActivityRemote(activity: activity)
            } else {
                everythingOffView
            }
        }
        .sheet(isPresented: $showMoreKeysSheet) {
            if let activity = viewModel.displayedActivity {
                MoreKeysSheet(
                    viewModel: viewModel,
                    target: .activity(activity.id),
                    title: activity.name,
                    participatingDevices: viewModel.configSnapshot?.participatingDevices(for: activity) ?? [],
                    softButtons: viewModel.extraSoftButtons(for: activity.id),
                    isEmbeddedPanel: false,
                    onDismiss: { showMoreKeysSheet = false }
                )
                .presentationDetents([.large])
            }
        }
    }

    // MARK: - Subviews

    private var disconnectedPlaceholder: some View {
        VStack(spacing: 16) {
            IconTileView(systemName: "wifi.exclamationmark", isActive: false, size: 64)
            Text(viewModel.connectionStatus == .connecting ? "Connecting to Harmony Hub…" : "No Harmony Hub connected")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(MelodiousTheme.onSurface)

            if case .unreachable(let reason) = viewModel.connectionStatus {
                Text(reason)
                    .font(.system(size: 14))
                    .foregroundStyle(MelodiousTheme.onPowerContainer)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            } else {
                Text("Add your hub by IP address or scan your local /24 subnet in Settings.")
                    .font(.system(size: 14))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }

            HStack(spacing: 12) {
                Button {
                    Task { await viewModel.scanSubnet(autoConnectIfSingle: true) }
                } label: {
                    HStack(spacing: 6) {
                        if viewModel.isScanningSubnet {
                            ProgressView().tint(MelodiousTheme.onPrimary)
                        } else {
                            Image(systemName: "network")
                        }
                        Text(viewModel.isScanningSubnet ? "Scanning…" : "Scan Network")
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(MelodiousTheme.onPrimary)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 11)
                    .background(Capsule().fill(MelodiousTheme.primary))
                }
                .buttonStyle(.plain)

                if let onNavigateToSettings = onNavigateToSettings {
                    Button(action: onNavigateToSettings) {
                        Text("Hub Settings")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(MelodiousTheme.primary)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 11)
                            .background(Capsule().fill(MelodiousTheme.key))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(24)
    }

    private func busySwitchingView(pendingId: String) -> some View {
        let title: String = {
            if pendingId == "-1" { return "Turning everything off…" }
            let name = viewModel.activities.first(where: { $0.id == pendingId })?.name ?? "activity"
            return "Starting \(name)…"
        }()

        return VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
                .tint(MelodiousTheme.primary)
            Text(title)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(MelodiousTheme.onSurface)
            Text("Your hub is switching devices and inputs.")
                .font(.system(size: 14))
                .foregroundStyle(MelodiousTheme.onSurfaceVariant)
        }
        .padding(24)
    }

    private var everythingOffView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Everything's off")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(MelodiousTheme.onSurface)
                    Text("Choose an activity to start, or tap Remote to preview its keys.")
                        .font(.system(size: 14))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                }
                .padding(.top, 8)

                VStack(spacing: 10) {
                    ForEach(viewModel.activities) { activity in
                        let devicesText = viewModel.configSnapshot?.deviceNames(for: activity).joined(separator: " · ") ?? activity.typeLabel
                        HStack(spacing: 14) {
                            IconTileView(systemName: activity.systemIconName, isActive: false, size: 48)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(activity.name)
                                    .font(.system(size: 17, weight: .medium))
                                    .foregroundStyle(MelodiousTheme.onSurface)
                                Text(devicesText.isEmpty ? activity.typeLabel : devicesText)
                                    .font(.system(size: 13))
                                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                    .lineLimit(1)
                            }
                            Spacer()

                            Button {
                                MelodiousHaptics.tap()
                                viewModel.previewActivityId = activity.id
                            } label: {
                                Text("Keys")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(Capsule().fill(MelodiousTheme.key))
                            }
                            .buttonStyle(.plain)

                            Button {
                                MelodiousHaptics.heavy()
                                Task { await viewModel.startActivity(activity.id) }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: "play.fill")
                                        .font(.system(size: 11))
                                    Text("Start")
                                        .font(.system(size: 14, weight: .semibold))
                                }
                                .foregroundStyle(MelodiousTheme.onPrimary)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(Capsule().fill(MelodiousTheme.primary))
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(14)
                        .background(
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(MelodiousTheme.card)
                        )
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: 680)
        }
    }

    private func activeActivityRemote(activity: HubActivity) -> some View {
        let isLive = (viewModel.currentActivityId == activity.id)
        let target = RemoteTarget.activity(activity.id)
        let keyMap = viewModel.keyMap(for: target)
        let softButtons = viewModel.extraSoftButtons(for: activity.id)
        let memberDevices = viewModel.configSnapshot?.participatingDevices(for: activity) ?? []
        let subtitle = viewModel.configSnapshot?.deviceNames(for: activity).joined(separator: ", ") ?? activity.typeLabel

        return VStack(spacing: 8) {
            // Top activity header bar
            HStack(spacing: 12) {
                Menu {
                    Section("Switch Activity") {
                        ForEach(viewModel.activities) { other in
                            Button {
                                Task { await viewModel.startActivity(other.id) }
                            } label: {
                                Label(
                                    other.id == viewModel.currentActivityId ? "\(other.name) (Running)" : other.name,
                                    systemImage: other.systemIconName
                                )
                            }
                        }
                    }
                    if !viewModel.isEverythingOff {
                        Divider()
                        Button(role: .destructive) {
                            Task { await viewModel.powerOff() }
                        } label: {
                            Label("Turn everything off", systemImage: "power")
                        }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(activity.name)
                                .font(.system(size: 22, weight: .semibold))
                                .foregroundStyle(MelodiousTheme.onSurface)
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                        }
                        HStack(spacing: 6) {
                            LiveStatusDot(isLive: isLive)
                            Text(isLive ? (subtitle.isEmpty ? "Running" : subtitle) : "Previewing keys (not running)")
                                .font(.system(size: 12))
                                .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                .lineLimit(1)
                        }
                    }
                }
                .buttonStyle(.plain)

                Spacer()

                // More keys / Device picker button
                Button {
                    MelodiousHaptics.tap()
                    showMoreKeysSheet = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 15, weight: .semibold))
                        Text("More keys")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(MelodiousTheme.onPrimaryContainer)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Capsule().fill(MelodiousTheme.primaryContainer))
                }
                .buttonStyle(.plain)

                // Power off or Start button
                if isLive {
                    Button {
                        MelodiousHaptics.heavy()
                        Task { await viewModel.powerOff() }
                    } label: {
                        Image(systemName: "power")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(MelodiousTheme.onPowerContainer)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(MelodiousTheme.powerContainer))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Power off \(activity.name)")
                } else {
                    Button {
                        MelodiousHaptics.heavy()
                        Task { await viewModel.startActivity(activity.id) }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "play.fill")
                                .font(.system(size: 11))
                            Text("Start")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(MelodiousTheme.onPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(Capsule().fill(MelodiousTheme.primary))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            // Status / last-sent feedback strip
            HStack(spacing: 8) {
                Circle()
                    .fill(viewModel.hbusConnected ? MelodiousTheme.live : MelodiousTheme.primary)
                    .frame(width: 6, height: 6)
                Text(viewModel.statusLine)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    .lineLimit(1)
                Spacer()
                if !isRegularWidth {
                    Button {
                        MelodiousHaptics.tap()
                        withAnimation(.easeInOut(duration: 0.15)) {
                            showNumpadInline.toggle()
                        }
                    } label: {
                        Text(showNumpadInline ? "D-Pad" : "123 Pad")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MelodiousTheme.primary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(MelodiousTheme.key))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)

            // Main body: side-by-side on iPad regular width, compact single column on iPhone
            if isRegularWidth {
                HStack(alignment: .top, spacing: 16) {
                    primaryKeypadColumn(target: target, keyMap: keyMap, softButtons: softButtons, showInlineNumpad: false)
                        .frame(maxWidth: 440)

                    MoreKeysSheet(
                        viewModel: viewModel,
                        target: target,
                        title: activity.name,
                        participatingDevices: memberDevices,
                        softButtons: softButtons,
                        isEmbeddedPanel: true
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .frame(maxWidth: 420)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            } else {
                primaryKeypadColumn(target: target, keyMap: keyMap, softButtons: softButtons, showInlineNumpad: showNumpadInline)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }
        }
    }

    private func primaryKeypadColumn(
        target: RemoteTarget,
        keyMap: [String: ResolvedButtonAction],
        softButtons: [SoftButton],
        showInlineNumpad: Bool
    ) -> some View {
        let menuIsHome = RemoteKeyMapping.sendsHome(in: keyMap, key: "Menu")
        let exitIsHome = RemoteKeyMapping.sendsHome(in: keyMap, key: "Exit") && !menuIsHome
        let activityId: String? = {
            if case .activity(let id) = target { return id }
            return nil
        }()

        return VStack(spacing: 10) {
            // Activity quick soft-buttons strip (Home, Aspect, Sleep, etc.)
            if !softButtons.isEmpty && !isRegularWidth {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(softButtons) { btn in
                            Button {
                                MelodiousHaptics.tap()
                                viewModel.pressSoftButton(btn, activityId: activityId)
                            } label: {
                                Text(btn.label)
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(MelodiousTheme.onPrimaryContainer)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 7)
                                    .background(
                                        Capsule()
                                            .fill(MelodiousTheme.primaryContainer.opacity(0.75))
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            // Playback transport row: Rewind, Play, Pause, FastForward, Stop, Record
            HStack(spacing: 6) {
                RemoteKeyButton(viewModel: viewModel, target: target, buttonKey: "Rewind", label: "Rewind", cornerRadius: 14) {
                    Image(systemName: "backward.fill").font(.system(size: 16))
                }
                RemoteKeyButton(
                    viewModel: viewModel,
                    target: target,
                    buttonKey: "Play",
                    label: "Play",
                    cornerRadius: 14,
                    baseColor: MelodiousTheme.primaryContainer
                ) {
                    Image(systemName: "play.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(MelodiousTheme.onPrimaryContainer)
                }
                RemoteKeyButton(viewModel: viewModel, target: target, buttonKey: "Pause", label: "Pause", cornerRadius: 14) {
                    Image(systemName: "pause.fill").font(.system(size: 16))
                }
                RemoteKeyButton(viewModel: viewModel, target: target, buttonKey: "FastForward", label: "Fast forward", cornerRadius: 14) {
                    Image(systemName: "forward.fill").font(.system(size: 16))
                }
                RemoteKeyButton(viewModel: viewModel, target: target, buttonKey: "Stop", label: "Stop", cornerRadius: 14) {
                    Image(systemName: "stop.fill").font(.system(size: 15))
                }
                RemoteKeyButton(viewModel: viewModel, target: target, buttonKey: "Record", label: "Record", cornerRadius: 14) {
                    Circle().fill(MelodiousTheme.keyRed).frame(width: 11, height: 11)
                }
            }
            .frame(height: 46)

            // Colour keys row (Red, Green, Yellow, Blue)
            RemoteColorKeysRow(viewModel: viewModel, target: target)

            // Center area: Circular D-Pad (or inline 123 Number Pad when toggled on compact iPhone)
            if showInlineNumpad {
                RemoteNumberPadGrid(viewModel: viewModel, target: target, keyHeight: 46)
                    .padding(.vertical, 4)
            } else {
                RemoteDPadView(
                    viewModel: viewModel,
                    target: target,
                    diameter: isRegularWidth ? 236 : 216
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, 2)
            }

            // Bottom cluster: VOL rocker + (Back, Menu/Home, Exit, Mute, Guide, Info) + CH rocker
            HStack(spacing: 10) {
                RemoteRockerView(
                    viewModel: viewModel,
                    target: target,
                    upKey: "VolumeUp",
                    downKey: "VolumeDown",
                    upLabel: "Volume up",
                    downLabel: "Volume down",
                    caption: "VOL",
                    useChevron: false
                )

                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        captionedKey(
                            target: target,
                            key: "PrevChannel",
                            label: "Back",
                            icon: "arrow.uturn.backward"
                        )
                        captionedKey(
                            target: target,
                            key: "Menu",
                            label: menuIsHome ? "Home" : "Menu",
                            icon: menuIsHome ? "house.fill" : "line.3.horizontal"
                        )
                    }
                    HStack(spacing: 8) {
                        captionedKey(
                            target: target,
                            key: "Exit",
                            label: exitIsHome ? "Home" : "Exit",
                            icon: exitIsHome ? "house.fill" : "rectangle.portrait.and.arrow.right"
                        )
                        captionedKey(
                            target: target,
                            key: "VolumeMute",
                            label: "Mute",
                            icon: "speaker.slash.fill"
                        )
                    }
                    HStack(spacing: 8) {
                        captionedKey(
                            target: target,
                            key: "Guide",
                            label: "Guide",
                            icon: "list.bullet.rectangle"
                        )
                        captionedKey(
                            target: target,
                            key: "Info",
                            label: "Info",
                            icon: "info.circle"
                        )
                    }
                }
                .frame(maxWidth: .infinity)

                RemoteRockerView(
                    viewModel: viewModel,
                    target: target,
                    upKey: "ChannelUp",
                    downKey: "ChannelDown",
                    upLabel: "Channel up",
                    downLabel: "Channel down",
                    caption: "CH",
                    useChevron: true
                )
            }
            .frame(height: 176)
        }
    }

    private func captionedKey(target: RemoteTarget, key: String, label: String, icon: String) -> some View {
        RemoteKeyButton(
            viewModel: viewModel,
            target: target,
            buttonKey: key,
            label: label,
            cornerRadius: 14
        ) {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .semibold))
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
            }
        }
    }
}
