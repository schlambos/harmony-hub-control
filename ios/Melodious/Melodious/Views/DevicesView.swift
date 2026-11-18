import SwiftUI

public struct DevicesView: View {
    @ObservedObject public var viewModel: HubViewModel
    @State private var selectedDevice: HubDevice?
    @State private var searchQuery: String = ""

    public init(viewModel: HubViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        ZStack {
            MelodiousTheme.canvas.ignoresSafeArea()

            if let device = selectedDevice ?? viewModel.devices.first(where: { $0.id == viewModel.selectedDeviceOverlayId }) {
                DeviceCommandsDetailView(
                    viewModel: viewModel,
                    device: device,
                    onBack: {
                        selectedDevice = nil
                        viewModel.selectedDeviceOverlayId = nil
                    }
                )
            } else {
                deviceListView
            }
        }
    }

    private var deviceListView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Devices")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(MelodiousTheme.onSurface)

                Text("Open a device and tap any command to send it through your Harmony Hub.")
                    .font(.system(size: 14))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)

                if viewModel.devices.isEmpty {
                    Text(viewModel.connectionStatus.isConnected
                         ? "No devices found on this hub."
                         : "Connect to your Harmony Hub in Settings to load devices.")
                        .font(.system(size: 14))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                        .padding(.vertical, 20)
                } else {
                    VStack(spacing: 10) {
                        ForEach(viewModel.devices) { device in
                            Button {
                                MelodiousHaptics.tap()
                                selectedDevice = device
                            } label: {
                                HStack(spacing: 14) {
                                    IconTileView(systemName: device.systemIconName, isActive: false, size: 46)

                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack(spacing: 8) {
                                            Text(device.name)
                                                .font(.system(size: 16, weight: .medium))
                                                .foregroundStyle(MelodiousTheme.onSurface)
                                            Text(device.transportBadge)
                                                .font(.system(size: 11, weight: .semibold))
                                                .foregroundStyle(MelodiousTheme.primary)
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 2)
                                                .background(Capsule().fill(MelodiousTheme.primaryContainer))
                                        }
                                        Text(device.subtitle)
                                            .font(.system(size: 13))
                                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                            .lineLimit(1)
                                    }

                                    Spacer()

                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                }
                                .padding(14)
                                .background(
                                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                                        .fill(MelodiousTheme.card)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
        }
    }
}

public struct DeviceCommandsDetailView: View {
    @ObservedObject public var viewModel: HubViewModel
    public let device: HubDevice
    public let onBack: () -> Void

    @State private var filterText: String = ""

    public init(viewModel: HubViewModel, device: HubDevice, onBack: @escaping () -> Void) {
        self.viewModel = viewModel
        self.device = device
        self.onBack = onBack
    }

    private var filteredCommands: [DeviceCommand] {
        let q = filterText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return device.commands }
        return device.commands.filter { $0.name.localizedCaseInsensitiveContains(q) }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Top bar
            HStack(spacing: 12) {
                Button(action: onBack) {
                    HStack(spacing: 5) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 15, weight: .semibold))
                        Text("Devices")
                            .font(.system(size: 15, weight: .medium))
                    }
                    .foregroundStyle(MelodiousTheme.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(MelodiousTheme.key))
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 2) {
                    Text(device.name)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.onSurface)
                    Text(device.subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                }

                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)

            // Status strip
            HStack(spacing: 8) {
                Circle()
                    .fill(MelodiousTheme.live)
                    .frame(width: 6, height: 6)
                Text(viewModel.statusLine)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 16)

            // Search bar
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                TextField("Search \(device.commands.count) commands…", text: $filterText)
                    .textFieldStyle(.plain)
                    .foregroundStyle(MelodiousTheme.onSurface)
                if !filterText.isEmpty {
                    Button {
                        filterText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(MelodiousTheme.card)
            )
            .padding(.horizontal, 16)

            // Commands grid
            ScrollView {
                let rows = Self.chunked(filteredCommands, size: 2)
                VStack(spacing: 10) {
                    ForEach(0..<rows.count, id: \.self) { rowIdx in
                        HStack(spacing: 10) {
                            ForEach(rows[rowIdx]) { cmd in
                                Button {
                                    MelodiousHaptics.tap()
                                    viewModel.sendDeviceCommand(device: device, command: cmd)
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(RemoteKeyMapping.humanizeLabel(cmd.name))
                                                .font(.system(size: 15, weight: .medium))
                                                .foregroundStyle(MelodiousTheme.onSurface)
                                                .lineLimit(1)
                                            Text(cmd.name)
                                                .font(.system(size: 11))
                                                .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                                .lineLimit(1)
                                        }
                                        Spacer()
                                        Image(systemName: "wave.3.right")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(MelodiousTheme.primary)
                                    }
                                    .padding(.horizontal, 14)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 54)
                                    .background(
                                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                                            .fill(MelodiousTheme.card)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                            if rows[rowIdx].count < 2 {
                                Color.clear.frame(maxWidth: .infinity, minHeight: 54)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
        }
        .frame(maxWidth: 760)
    }

    private static func chunked<T>(_ array: [T], size: Int) -> [[T]] {
        guard size > 0, !array.isEmpty else { return [] }
        var result: [[T]] = []
        var idx = 0
        while idx < array.count {
            let end = min(idx + size, array.count)
            result.append(Array(array[idx..<end]))
            idx = end
        }
        return result
    }
}
