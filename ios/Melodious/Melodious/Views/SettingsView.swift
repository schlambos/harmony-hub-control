import SwiftUI

public struct SettingsView: View {
    @ObservedObject public var viewModel: HubViewModel

    @State private var hostInput: String = ""
    @State private var portInput: String = "8080"
    @State private var showAuthFields: Bool = false
    @State private var usernameInput: String = ""
    @State private var passwordInput: String = ""
    @State private var showSideloadGuide: Bool = false

    public init(viewModel: HubViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        ZStack {
            MelodiousTheme.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Settings")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(MelodiousTheme.onSurface)

                    // 1. Active Hub & Version Card
                    if let endpoint = viewModel.activeEndpoint {
                        connectedHubCard(endpoint: endpoint)
                    }

                    // 2. Manual Connection & Subnet Scan Card
                    manualConnectionCard

                    // 3. Discovered Hubs (from Subnet Scan)
                    if !viewModel.discoveredHubs.isEmpty {
                        discoveredHubsCard
                    }

                    // 4. Saved Hubs Card
                    if !viewModel.savedHubs.isEmpty {
                        savedHubsCard
                    }

                    // 5. App Version & Sideloading Help Card
                    aboutAndSideloadingCard
                }
                .padding(16)
                .frame(maxWidth: 720)
            }
        }
        .onAppear {
            if hostInput.isEmpty, let active = viewModel.activeEndpoint {
                hostInput = active.host
                portInput = String(active.webUiPort)
            }
        }
        .sheet(isPresented: $showSideloadGuide) {
            sideloadingHelpSheet
        }
    }

    private func connectedHubCard(endpoint: HubEndpoint) -> some View {
        let isConnected = viewModel.connectionStatus.isConnected
        let versionString = viewModel.versionInfo?.version ?? (endpoint.melodiousVersion.isEmpty ? "Unknown" : endpoint.melodiousVersion)
        let firmwareString = viewModel.systemStatus?.firmware ?? (endpoint.firmware.isEmpty ? "Harmony Hub" : endpoint.firmware)
        let features = viewModel.versionInfo?.features ?? endpoint.features

        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                LiveStatusDot(isLive: isConnected)
                Text(isConnected ? "Connected Hub" : "Current Hub Target")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isConnected ? MelodiousTheme.live : MelodiousTheme.warning)
                Spacer()
                Text(endpoint.isSimulated ? "SIMULATOR" : (viewModel.hbusConnected ? "HBUS WS :8088" : "HTTP :\(endpoint.webUiPort)"))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(MelodiousTheme.primary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(MelodiousTheme.primaryContainer))
            }

            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(endpoint.name)
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.onSurface)
                    Text("http://\(endpoint.displayAddress)")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                }
                Spacer()
            }

            if case .unreachable(let errText) = viewModel.connectionStatus {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(MelodiousTheme.onPowerContainer)
                    Text(errText)
                        .font(.system(size: 13))
                        .foregroundStyle(MelodiousTheme.onPowerContainer)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(MelodiousTheme.powerContainer)
                )
            }

            Divider().background(MelodiousTheme.divider)

            HStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Melodious Version")
                        .font(.system(size: 12))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    Text("v\(versionString)")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.onSurface)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hub Firmware")
                        .font(.system(size: 12))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    Text(firmwareString)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(MelodiousTheme.onSurface)
                }
            }

            if !features.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Feature flags (/api/version)")
                        .font(.system(size: 12))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(features, id: \.self) { flag in
                                Text(flag)
                                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                                    .foregroundStyle(MelodiousTheme.onSurface)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Capsule().fill(MelodiousTheme.key))
                            }
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(MelodiousTheme.card)
        )
    }

    private var manualConnectionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect to a Harmony Hub")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(MelodiousTheme.primary)

            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Hub IP or Hostname")
                        .font(.system(size: 12))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    TextField("192.168.1.50 or 127.0.0.1", text: $hostInput)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15, design: .monospaced))
                        .foregroundStyle(MelodiousTheme.onSurface)
                        .padding(10)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(MelodiousTheme.key)
                        )
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Port")
                        .font(.system(size: 12))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    TextField("8080", text: $portInput)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15, design: .monospaced))
                        .foregroundStyle(MelodiousTheme.onSurface)
                        .frame(width: 78)
                        .padding(10)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(MelodiousTheme.key)
                        )
                }
            }

            DisclosureGroup("HTTP Basic Auth (optional)", isExpanded: $showAuthFields) {
                HStack(spacing: 10) {
                    TextField("Username", text: $usernameInput)
                        .textFieldStyle(.plain)
                        .foregroundStyle(MelodiousTheme.onSurface)
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 10).fill(MelodiousTheme.key))
                    SecureField("Password", text: $passwordInput)
                        .textFieldStyle(.plain)
                        .foregroundStyle(MelodiousTheme.onSurface)
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 10).fill(MelodiousTheme.key))
                }
                .padding(.top, 8)
            }
            .font(.system(size: 13))
            .foregroundStyle(MelodiousTheme.onSurfaceVariant)

            HStack(spacing: 10) {
                Button {
                    MelodiousHaptics.tap()
                    Task {
                        await viewModel.connectManual(
                            hostInput: hostInput,
                            portInput: portInput,
                            username: usernameInput,
                            password: passwordInput
                        )
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "bolt.horizontal.fill")
                        Text("Connect")
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(MelodiousTheme.onPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Capsule().fill(MelodiousTheme.primary))
                }
                .buttonStyle(.plain)

                Button {
                    MelodiousHaptics.tap()
                    Task { await viewModel.scanSubnet(autoConnectIfSingle: false) }
                } label: {
                    HStack(spacing: 6) {
                        if viewModel.isScanningSubnet {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "network")
                        }
                        Text(viewModel.isScanningSubnet ? "Scanning /24…" : "Scan Subnet (/24)")
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(MelodiousTheme.onPrimaryContainer)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Capsule().fill(MelodiousTheme.primaryContainer))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(MelodiousTheme.card)
        )
    }

    private var discoveredHubsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Discovered on local network")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(MelodiousTheme.primary)

            ForEach(viewModel.discoveredHubs) { hub in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(hub.name)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(MelodiousTheme.onSurface)
                        Text("\(hub.displayAddress) · Melodious v\(hub.melodiousVersion.isEmpty ? "?" : hub.melodiousVersion)")
                            .font(.system(size: 12))
                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    }
                    Spacer()
                    Button {
                        hostInput = hub.host
                        portInput = String(hub.webUiPort)
                        Task { await viewModel.connect(to: hub) }
                    } label: {
                        Text(viewModel.activeEndpoint?.id == hub.id && viewModel.connectionStatus.isConnected ? "Connected" : "Use Hub")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(MelodiousTheme.onPrimary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(MelodiousTheme.primary))
                    }
                    .buttonStyle(.plain)
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 14).fill(MelodiousTheme.key))
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(MelodiousTheme.card))
    }

    private var savedHubsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Saved Hubs (auto-reconnects to last used)")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(MelodiousTheme.primary)

            ForEach(viewModel.savedHubs) { hub in
                let isCurrent = (viewModel.activeEndpoint?.id == hub.id)
                HStack(spacing: 10) {
                    LiveStatusDot(isLive: isCurrent && viewModel.connectionStatus.isConnected)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(hub.name)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(MelodiousTheme.onSurface)
                        Text(hub.displayAddress)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    }
                    Spacer()

                    if !isCurrent || !viewModel.connectionStatus.isConnected {
                        Button {
                            hostInput = hub.host
                            portInput = String(hub.webUiPort)
                            Task { await viewModel.connect(to: hub) }
                        } label: {
                            Text("Connect")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(MelodiousTheme.primary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Capsule().fill(MelodiousTheme.surfaceHighest))
                        }
                        .buttonStyle(.plain)
                    }

                    Button {
                        viewModel.removeSavedHub(hub)
                    } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 13))
                            .foregroundStyle(MelodiousTheme.onPowerContainer)
                            .padding(8)
                            .background(Circle().fill(MelodiousTheme.powerContainer))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(hub.name)")
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 14).fill(MelodiousTheme.key))
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(MelodiousTheme.card))
    }

    private var aboutAndSideloadingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("About & Sideloading")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(MelodiousTheme.primary)

            HStack {
                Text("App Version")
                    .font(.system(size: 14))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                Spacer()
                Text("2.5.0 (build 1) · Experimental Baseline")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(MelodiousTheme.onSurface)
            }

            HStack {
                Text("Bundle Identifier")
                    .font(.system(size: 14))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                Spacer()
                Text("app.melodious.ios")
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(MelodiousTheme.onSurface)
            }

            Divider().background(MelodiousTheme.divider)

            HStack(spacing: 10) {
                Button {
                    showSideloadGuide = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "book.fill")
                        Text("Sideloading Help (docs/IOS_APP.md)")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(MelodiousTheme.onPrimaryContainer)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Capsule().fill(MelodiousTheme.primaryContainer))
                }
                .buttonStyle(.plain)

                if let url = URL(string: "https://github.com/schlambos/harmony-hub-control/blob/main/docs/IOS_APP.md") {
                    Link(destination: url) {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.up.right.square")
                            Text("GitHub Docs")
                        }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.primary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(Capsule().fill(MelodiousTheme.key))
                    }
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(MelodiousTheme.card))
    }

    private var sideloadingHelpSheet: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("iOS Sideloading Guide")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.onSurface)
                    Spacer()
                    Button("Done") { showSideloadGuide = false }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.primary)
                }

                Group {
                    Text("1. AltStore & SideStore (.ipa)")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.primary)
                    Text("Melodious ships as an unsigned archive (`melodious-ios-2.5.0.ipa`) for sideloading. Import the `.ipa` into AltStore or SideStore on your iPhone or iPad, which signs it with your own Apple ID.")
                        .font(.system(size: 14))
                        .foregroundStyle(MelodiousTheme.onSurface)

                    Text("2. 7-Day Free Apple ID Refresh")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.primary)
                    Text("Apps signed with a free Personal Team Apple ID expire after 7 days (and allow up to 3 active sideloaded apps per device). SideStore can refresh Melodious on-device over its local WireGuard loopback VPN without needing your computer open; AltStore refreshes over Wi-Fi whenever AltServer is running on your Mac or PC.")
                        .font(.system(size: 14))
                        .foregroundStyle(MelodiousTheme.onSurface)

                    Text("3. Xcode Free Provisioning (Build from Source)")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.primary)
                    Text("Open `ios/Melodious/Melodious.xcodeproj` in Xcode on your Mac, select the `Melodious` target → Signing & Capabilities → enable Automatically manage signing, choose your Personal Team, and press Run with your iPad or iPhone connected.")
                        .font(.system(size: 14))
                        .foregroundStyle(MelodiousTheme.onSurface)
                }
            }
            .padding(24)
        }
        .background(MelodiousTheme.surfaceHigh)
    }
}
