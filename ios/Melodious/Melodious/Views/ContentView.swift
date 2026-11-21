import SwiftUI

public enum MelodiousTab: String, CaseIterable, Identifiable, Sendable {
    case remote = "Remote"
    case activities = "Activities"
    case devices = "Devices"
    case settings = "Settings"

    public var id: String { rawValue }

    public var systemIcon: String {
        switch self {
        case .remote: return "av.remote.fill"
        case .activities: return "tv.fill"
        case .devices: return "slider.horizontal.3"
        case .settings: return "gearshape.fill"
        }
    }
}

public struct ContentView: View {
    @ObservedObject public var viewModel: HubViewModel
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @State public var selectedTab: MelodiousTab

    public init(viewModel: HubViewModel, initialTab: MelodiousTab = .remote) {
        self.viewModel = viewModel
        self._selectedTab = State(initialValue: initialTab)
    }

    public var body: some View {
        GeometryReader { geo in
            #if os(iOS)
            let isIPadSplit = (horizontalSizeClass == .regular) && (geo.size.width >= 700)
            #else
            let isIPadSplit = geo.size.width >= 700
            #endif
            ZStack(alignment: .bottom) {
                MelodiousTheme.canvas.ignoresSafeArea()

                if isIPadSplit {
                    iPadSplitLayout(totalWidth: geo.size.width)
                } else {
                    iPhoneCompactTabLayout
                }

                if let banner = viewModel.bannerMessage {
                    snackbarView(banner: banner)
                        .padding(.bottom, isIPadSplit ? 20 : 88)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - iPad Split View (Hub / Activities Sidebar + Remote Detail)

    private func iPadSplitLayout(totalWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            // Left Sidebar: Hub status + Navigation + Live Activities & Devices
            VStack(alignment: .leading, spacing: 14) {
                // Brand & Hub Status Header
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(MelodiousTheme.primaryContainer)
                                .frame(width: 34, height: 34)
                            Image(systemName: "wave.3.right")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(MelodiousTheme.primary)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Melodious")
                                .font(.system(size: 18, weight: .bold))
                                .foregroundStyle(MelodiousTheme.onSurface)
                            if let ep = viewModel.activeEndpoint {
                                HStack(spacing: 5) {
                                    LiveStatusDot(isLive: viewModel.connectionStatus.isConnected)
                                    Text("\(ep.displayAddress)\(ep.melodiousVersion.isEmpty ? "" : " · v\(ep.melodiousVersion)")")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                        .lineLimit(1)
                                }
                            } else {
                                Text("No hub connected")
                                    .font(.system(size: 11))
                                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                            }
                        }
                        Spacer()
                        if !viewModel.isEverythingOff {
                            Button {
                                MelodiousHaptics.heavy()
                                Task { await viewModel.powerOff() }
                            } label: {
                                Image(systemName: "power")
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(MelodiousTheme.onPowerContainer)
                                    .frame(width: 32, height: 32)
                                    .background(Circle().fill(MelodiousTheme.powerContainer))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Power off")
                        }
                    }
                }
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(MelodiousTheme.card)
                )

                // Detail Pane Section Switcher
                HStack(spacing: 6) {
                    ForEach(MelodiousTab.allCases) { tab in
                        let isSelected = (selectedTab == tab)
                        Button {
                            MelodiousHaptics.tap()
                            selectedTab = tab
                        } label: {
                            VStack(spacing: 4) {
                                Image(systemName: tab.systemIcon)
                                    .font(.system(size: 14, weight: .semibold))
                                Text(tab.rawValue)
                                    .font(.system(size: 11, weight: .semibold))
                            }
                            .foregroundStyle(isSelected ? MelodiousTheme.onPrimaryContainer : MelodiousTheme.onSurfaceVariant)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(isSelected ? MelodiousTheme.primaryContainer : MelodiousTheme.card)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }

                // Sidebar Scrollable Activities & Devices Roster
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        // Activities Section
                        HStack {
                            Text("Activities")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(MelodiousTheme.primary)
                            Spacer()
                            if !viewModel.isEverythingOff {
                                Button {
                                    Task { await viewModel.powerOff() }
                                } label: {
                                    Text("All Off")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(MelodiousTheme.onPowerContainer)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(Capsule().fill(MelodiousTheme.powerContainer))
                                }
                                .buttonStyle(.plain)
                            }
                        }

                        VStack(spacing: 8) {
                            ForEach(viewModel.activities) { activity in
                                sidebarActivityRow(activity)
                            }
                        }

                        // Devices Quick Access Section
                        Text("Devices (\(viewModel.devices.count))")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(MelodiousTheme.primary)
                            .padding(.top, 6)

                        VStack(spacing: 6) {
                            ForEach(viewModel.devices) { device in
                                Button {
                                    MelodiousHaptics.tap()
                                    viewModel.selectedDeviceOverlayId = device.id
                                    selectedTab = .devices
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: device.systemIconName)
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(MelodiousTheme.primary)
                                            .frame(width: 28, height: 28)
                                            .background(RoundedRectangle(cornerRadius: 8).fill(MelodiousTheme.key))
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(device.name)
                                                .font(.system(size: 14, weight: .medium))
                                                .foregroundStyle(MelodiousTheme.onSurface)
                                                .lineLimit(1)
                                            Text("\(device.transportBadge) · \(device.commands.count) cmds")
                                                .font(.system(size: 11))
                                                .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                    }
                                    .padding(10)
                                    .background(
                                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                                            .fill(MelodiousTheme.card)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(.bottom, 16)
                }
            }
            .padding(14)
            .frame(width: 310)
            .background(MelodiousTheme.navBar)

            Rectangle()
                .fill(MelodiousTheme.divider)
                .frame(width: 1)

            // Right Detail Pane
            ZStack {
                switch selectedTab {
                case .remote:
                    RemoteView(
                        viewModel: viewModel,
                        isRegularWidth: (totalWidth - 311) >= 720,
                        onNavigateToSettings: { selectedTab = .settings }
                    )
                case .activities:
                    ActivitiesView(
                        viewModel: viewModel,
                        onOpenRemote: { selectedTab = .remote }
                    )
                case .devices:
                    DevicesView(viewModel: viewModel)
                case .settings:
                    SettingsView(viewModel: viewModel)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func sidebarActivityRow(_ activity: HubActivity) -> some View {
        let isRunning = (viewModel.currentActivityId == activity.id)
        let isDisplayed = (viewModel.displayedActivity?.id == activity.id)
        let devicesText = viewModel.configSnapshot?.deviceNames(for: activity).joined(separator: " · ") ?? activity.typeLabel

        return HStack(spacing: 10) {
            Button {
                MelodiousHaptics.tap()
                viewModel.previewActivityId = activity.id
                selectedTab = .remote
            } label: {
                HStack(spacing: 10) {
                    ActivityTileView(activity: activity, viewModel: viewModel, isActive: isRunning, size: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(activity.name)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(MelodiousTheme.onSurface)
                                .lineLimit(1)
                            if isRunning {
                                LiveStatusDot(isLive: true)
                            }
                        }
                        Text(devicesText)
                            .font(.system(size: 11))
                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                            .lineLimit(1)
                    }
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            Button {
                MelodiousHaptics.heavy()
                selectedTab = .remote
                Task {
                    if isRunning {
                        await viewModel.powerOff()
                    } else {
                        await viewModel.startActivity(activity.id)
                    }
                }
            } label: {
                Text(isRunning ? "Off" : "Start")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isRunning ? MelodiousTheme.onPowerContainer : MelodiousTheme.onSurface)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(
                        Capsule()
                            .fill(isRunning ? MelodiousTheme.powerContainer : MelodiousTheme.keyRaised)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isRunning ? MelodiousTheme.runningCard : (isDisplayed ? MelodiousTheme.key : MelodiousTheme.card))
        )
    }

    // MARK: - iPhone Compact Tab Layout

    private var iPhoneCompactTabLayout: some View {
        VStack(spacing: 0) {
            ZStack {
                switch selectedTab {
                case .remote:
                    RemoteView(
                        viewModel: viewModel,
                        isRegularWidth: false,
                        onNavigateToSettings: { selectedTab = .settings }
                    )
                case .activities:
                    ActivitiesView(
                        viewModel: viewModel,
                        onOpenRemote: { selectedTab = .remote }
                    )
                case .devices:
                    DevicesView(viewModel: viewModel)
                case .settings:
                    SettingsView(viewModel: viewModel)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Rectangle()
                .fill(MelodiousTheme.divider)
                .frame(height: 1)

            // Bottom Navigation Bar (DESIGN.md §4)
            HStack(spacing: 0) {
                ForEach(MelodiousTab.allCases) { tab in
                    let isSelected = (selectedTab == tab)
                    Button {
                        MelodiousHaptics.tap()
                        selectedTab = tab
                    } label: {
                        VStack(spacing: 4) {
                            ZStack {
                                Capsule()
                                    .fill(isSelected ? MelodiousTheme.primaryContainer : Color.clear)
                                    .frame(width: 56, height: 30)
                                Image(systemName: tab.systemIcon)
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(isSelected ? MelodiousTheme.onPrimaryContainer : MelodiousTheme.onSurfaceVariant)
                            }
                            Text(tab.rawValue)
                                .font(.system(size: 12, weight: isSelected ? .semibold : .medium))
                                .foregroundStyle(isSelected ? MelodiousTheme.onSurface : MelodiousTheme.onSurfaceVariant)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(MelodiousTheme.navBar)
        }
    }

    private func snackbarView(banner: BannerMessage) -> some View {
        HStack(spacing: 10) {
            Image(systemName: banner.isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(banner.isError ? MelodiousTheme.onPowerContainer : MelodiousTheme.live)
            Text(banner.text)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(banner.isError ? MelodiousTheme.onPowerContainer : MelodiousTheme.onSurface)
                .lineLimit(2)
            Spacer()
            Button {
                viewModel.dismissBanner()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: 480)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(banner.isError ? MelodiousTheme.powerContainer : MelodiousTheme.surfaceHighest)
                .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        )
        .padding(.horizontal, 16)
    }
}
