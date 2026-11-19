import SwiftUI

/// "More keys" sheet (and side panel on wide iPad layouts):
/// - Activity on-screen / extra soft buttons (`16417Activity<id>`)
/// - Secondary keys (`Guide`, `Info`, `DVR`, `Exit`, `Record`, `Stop`) and Colour keys
/// - Number pad (`1`–`9`, `–`, `0`, `Enter`)
/// - Device picker to send any command directly to a specific device
public struct MoreKeysSheet: View {
    @ObservedObject public var viewModel: HubViewModel
    public let target: RemoteTarget
    public let title: String
    public let participatingDevices: [HubDevice]
    public let softButtons: [SoftButton]
    public var isEmbeddedPanel: Bool = false
    public var onDismiss: (() -> Void)?

    @State private var selectedMode: MoreKeysTab = .keys
    @State private var selectedDeviceId: String = ""
    @State private var commandSearchQuery: String = ""

    public enum MoreKeysTab: String, CaseIterable {
        case keys = "Extra Keys & Numpad"
        case deviceCommands = "Device Picker"
    }

    public init(
        viewModel: HubViewModel,
        target: RemoteTarget,
        title: String,
        participatingDevices: [HubDevice],
        softButtons: [SoftButton],
        isEmbeddedPanel: Bool = false,
        onDismiss: (() -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.target = target
        self.title = title
        self.participatingDevices = participatingDevices
        self.softButtons = softButtons
        self.isEmbeddedPanel = isEmbeddedPanel
        self.onDismiss = onDismiss
    }

    private var activityId: String? {
        if case .activity(let id) = target { return id }
        return nil
    }

    private var availableDevices: [HubDevice] {
        let all = viewModel.devices
        if participatingDevices.isEmpty { return all }
        let memberIds = Set(participatingDevices.map(\.id))
        let others = all.filter { !memberIds.contains($0.id) }
        return participatingDevices + others
    }

    private var activeDevice: HubDevice? {
        if !selectedDeviceId.isEmpty,
           let matched = availableDevices.first(where: { $0.id == selectedDeviceId }) {
            return matched
        }
        return availableDevices.first
    }

    public var body: some View {
        VStack(spacing: 12) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(selectedMode == .keys ? "More keys" : "Send to device")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.onSurface)
                    Text(title)
                        .font(.system(size: 13))
                        .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                }
                Spacer()
                if let onDismiss = onDismiss, !isEmbeddedPanel {
                    Button(action: onDismiss) {
                        Text("Done")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(MelodiousTheme.primary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(MelodiousTheme.key))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, isEmbeddedPanel ? 12 : 16)

            // Mode selector
            HStack(spacing: 6) {
                ForEach(MoreKeysTab.allCases, id: \.self) { tab in
                    let selected = (selectedMode == tab)
                    Button {
                        MelodiousHaptics.tap()
                        selectedMode = tab
                    } label: {
                        Text(tab.rawValue)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(selected ? MelodiousTheme.onPrimaryContainer : MelodiousTheme.onSurfaceVariant)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(
                                Capsule()
                                    .fill(selected ? MelodiousTheme.primaryContainer : Color.clear)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(4)
            .background(Capsule().fill(MelodiousTheme.key))
            .padding(.horizontal, 16)

            if selectedMode == .keys {
                extraKeysContent
            } else {
                devicePickerContent
            }
        }
        .background(isEmbeddedPanel ? MelodiousTheme.card : MelodiousTheme.surfaceHigh)
        .onAppear {
            if selectedDeviceId.isEmpty {
                selectedDeviceId = availableDevices.first?.id ?? ""
            }
        }
    }

    private var extraKeysContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // On-screen soft buttons for this activity
                if !softButtons.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("This activity")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(MelodiousTheme.primary)

                        let rows = Self.chunked(softButtons, size: 3)
                        VStack(spacing: 8) {
                            ForEach(0..<rows.count, id: \.self) { rowIdx in
                                HStack(spacing: 8) {
                                    ForEach(rows[rowIdx]) { btn in
                                        Button {
                                            MelodiousHaptics.tap()
                                            viewModel.pressSoftButton(btn, activityId: activityId)
                                        } label: {
                                            VStack(spacing: 2) {
                                                Text(btn.label)
                                                    .font(.system(size: 14, weight: .medium))
                                                    .foregroundStyle(MelodiousTheme.onPrimaryContainer)
                                                    .lineLimit(1)
                                                Text(btn.deviceName)
                                                    .font(.system(size: 11))
                                                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                                                    .lineLimit(1)
                                            }
                                            .frame(maxWidth: .infinity)
                                            .frame(height: 50)
                                            .background(
                                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                                    .fill(MelodiousTheme.primaryContainer.opacity(0.65))
                                            )
                                        }
                                        .buttonStyle(.plain)
                                    }
                                    if rows[rowIdx].count < 3 {
                                        ForEach(0..<(3 - rows[rowIdx].count), id: \.self) { _ in
                                            Color.clear.frame(maxWidth: .infinity, minHeight: 50)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Secondary function keys (Guide, Info, DVR, Exit, Record, Stop)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Function & colour keys")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.primary)

                    HStack(spacing: 8) {
                        ForEach([("Guide", "Guide"), ("Info", "Info"), ("Dvr", "DVR"), ("Exit", "Exit")], id: \.0) { key, label in
                            RemoteKeyButton(
                                viewModel: viewModel,
                                target: target,
                                buttonKey: key,
                                label: label,
                                cornerRadius: 14,
                                baseColor: MelodiousTheme.surfaceHighest
                            ) {
                                Text(label)
                                    .font(.system(size: 14, weight: .medium))
                            }
                            .frame(height: 46)
                        }
                    }

                    HStack(spacing: 8) {
                        RemoteKeyButton(
                            viewModel: viewModel,
                            target: target,
                            buttonKey: "Record",
                            label: "Record",
                            cornerRadius: 14,
                            baseColor: MelodiousTheme.surfaceHighest
                        ) {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(MelodiousTheme.keyRed)
                                    .frame(width: 10, height: 10)
                                Text("Rec")
                                    .font(.system(size: 14, weight: .medium))
                            }
                        }
                        .frame(height: 44)

                        RemoteKeyButton(
                            viewModel: viewModel,
                            target: target,
                            buttonKey: "Stop",
                            label: "Stop",
                            cornerRadius: 14,
                            baseColor: MelodiousTheme.surfaceHighest
                        ) {
                            HStack(spacing: 6) {
                                Image(systemName: "stop.fill")
                                    .font(.system(size: 12))
                                Text("Stop")
                                    .font(.system(size: 14, weight: .medium))
                            }
                        }
                        .frame(height: 44)
                    }

                    RemoteColorKeysRow(viewModel: viewModel, target: target)
                }

                // Number pad
                VStack(alignment: .leading, spacing: 8) {
                    Text("Number pad")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.primary)

                    RemoteNumberPadGrid(viewModel: viewModel, target: target, keyHeight: 48)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 20)
        }
    }

    private var devicePickerContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Horizontal device selector chips
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(availableDevices) { device in
                        let isSelected = (device.id == activeDevice?.id)
                        let isMember = participatingDevices.contains(where: { $0.id == device.id })
                        Button {
                            MelodiousHaptics.tap()
                            selectedDeviceId = device.id
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: device.systemIconName)
                                    .font(.system(size: 13, weight: .semibold))
                                Text(device.name)
                                    .font(.system(size: 13, weight: .medium))
                                if isMember {
                                    Circle()
                                        .fill(MelodiousTheme.live)
                                        .frame(width: 6, height: 6)
                                }
                            }
                            .foregroundStyle(isSelected ? MelodiousTheme.onPrimary : MelodiousTheme.onSurface)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(
                                Capsule()
                                    .fill(isSelected ? MelodiousTheme.primary : MelodiousTheme.key)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            }

            // Search bar
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                TextField("Filter commands…", text: $commandSearchQuery)
                    .textFieldStyle(.plain)
                    .foregroundStyle(MelodiousTheme.onSurface)
                if !commandSearchQuery.isEmpty {
                    Button {
                        commandSearchQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(MelodiousTheme.key)
            )
            .padding(.horizontal, 16)

            // Commands grid for selected device
            if let device = activeDevice {
                let query = commandSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
                let filtered = device.commands.filter {
                    query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
                }

                ScrollView {
                    let rows = Self.chunked(filtered, size: 2)
                    VStack(spacing: 8) {
                        ForEach(0..<rows.count, id: \.self) { rowIdx in
                            HStack(spacing: 8) {
                                ForEach(rows[rowIdx]) { cmd in
                                    Button {
                                        MelodiousHaptics.tap()
                                        viewModel.sendDeviceCommand(device: device, command: cmd, activityId: activityId)
                                    } label: {
                                        HStack {
                                            Text(RemoteKeyMapping.humanizeLabel(cmd.name))
                                                .font(.system(size: 14, weight: .medium))
                                                .foregroundStyle(MelodiousTheme.onSurface)
                                                .lineLimit(1)
                                            Spacer()
                                            Image(systemName: "wave.3.right")
                                                .font(.system(size: 11))
                                                .foregroundStyle(MelodiousTheme.primary)
                                        }
                                        .padding(.horizontal, 12)
                                        .frame(maxWidth: .infinity)
                                        .frame(height: 44)
                                        .background(
                                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                                .fill(MelodiousTheme.surfaceHighest)
                                        )
                                    }
                                    .buttonStyle(.plain)
                                }
                                if rows[rowIdx].count < 2 {
                                    Color.clear.frame(maxWidth: .infinity, minHeight: 44)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 20)
                }
            } else {
                Text("No devices found on this hub.")
                    .font(.system(size: 14))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    .padding(16)
                Spacer()
            }
        }
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
