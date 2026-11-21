import SwiftUI

public struct ActivitiesView: View {
    @ObservedObject public var viewModel: HubViewModel
    public var onOpenRemote: (() -> Void)?

    public init(viewModel: HubViewModel, onOpenRemote: (() -> Void)? = nil) {
        self.viewModel = viewModel
        self.onOpenRemote = onOpenRemote
    }

    public var body: some View {
        ZStack {
            MelodiousTheme.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    // Header
                    HStack {
                        Text("Activities")
                            .font(.system(size: 28, weight: .medium))
                            .foregroundStyle(MelodiousTheme.onSurface)
                        Spacer()
                        Button {
                            Task { await viewModel.refreshHubState() }
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: 13, weight: .semibold))
                                Text("Refresh")
                                    .font(.system(size: 13, weight: .medium))
                            }
                            .foregroundStyle(MelodiousTheme.primary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(MelodiousTheme.key))
                        }
                        .buttonStyle(.plain)
                    }

                    // Running activity banner card
                    if let running = viewModel.runningActivity {
                        runningActivityCard(running)
                    } else {
                        everythingOffCard
                    }

                    // All activities list
                    Text("All activities (\(viewModel.activities.count))")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.primary)
                        .padding(.top, 4)

                    if viewModel.activities.isEmpty {
                        Text(viewModel.connectionStatus.isConnected
                             ? "No activities configured on this hub."
                             : "Connect to your Harmony Hub in Settings to load activities.")
                            .font(.system(size: 14))
                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                            .padding(.vertical, 16)
                    } else {
                        VStack(spacing: 10) {
                            ForEach(viewModel.activities) { activity in
                                activityRow(activity)
                            }
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: 720)
            }
        }
    }

    private func runningActivityCard(_ activity: HubActivity) -> some View {
        let devicesText = viewModel.configSnapshot?.deviceNames(for: activity).joined(separator: " · ") ?? activity.typeLabel
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ActivityTileView(activity: activity, viewModel: viewModel, isActive: true, size: 48)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        LiveStatusDot(isLive: true)
                        Text("Running now")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(MelodiousTheme.live)
                    }
                    Text(activity.name)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.onSurface)
                    if !devicesText.isEmpty {
                        Text(devicesText)
                            .font(.system(size: 13))
                            .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                            .lineLimit(1)
                    }
                }
                Spacer()
            }

            HStack(spacing: 10) {
                Button {
                    MelodiousHaptics.tap()
                    viewModel.previewActivityId = activity.id
                    onOpenRemote?()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "av.remote.fill")
                        Text("Open remote")
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(MelodiousTheme.onPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Capsule().fill(MelodiousTheme.primary))
                }
                .buttonStyle(.plain)

                Button {
                    MelodiousHaptics.heavy()
                    Task { await viewModel.powerOff() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "power")
                        Text("Power off")
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(MelodiousTheme.onPowerContainer)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Capsule().fill(MelodiousTheme.powerContainer))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(MelodiousTheme.runningCard)
        )
    }

    private var everythingOffCard: some View {
        HStack(spacing: 12) {
            IconTileView(systemName: "power", isActive: false, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text("Everything's off")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(MelodiousTheme.onSurface)
                Text("Start an activity below to power on its devices and switch inputs.")
                    .font(.system(size: 13))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
            }
            Spacer()
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(MelodiousTheme.card)
        )
    }

    private func activityRow(_ activity: HubActivity) -> some View {
        let isRunning = (viewModel.currentActivityId == activity.id)
        let isPending = (viewModel.pendingActivityId == activity.id)
        let devicesText = viewModel.configSnapshot?.deviceNames(for: activity).joined(separator: " · ") ?? activity.typeLabel
        let keyCount = viewModel.configSnapshot?.resolvedKeyMap(forActivityId: activity.id).count ?? 0

        return HStack(spacing: 14) {
            ActivityTileView(activity: activity, viewModel: viewModel, isActive: isRunning, size: 46)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(activity.name)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(MelodiousTheme.onSurface)
                    if isRunning {
                        LiveStatusDot(isLive: true)
                    }
                }
                Text(devicesText.isEmpty ? "\(activity.typeLabel) · \(keyCount) keys" : "\(devicesText) · \(keyCount) keys")
                    .font(.system(size: 13))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    .lineLimit(1)
            }

            Spacer()

            Button {
                MelodiousHaptics.tap()
                viewModel.previewActivityId = activity.id
                onOpenRemote?()
            } label: {
                Text("Remote")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(MelodiousTheme.key))
            }
            .buttonStyle(.plain)

            if isRunning {
                Button {
                    MelodiousHaptics.heavy()
                    Task { await viewModel.powerOff() }
                } label: {
                    Text("Turn off")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MelodiousTheme.onPowerContainer)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(MelodiousTheme.powerContainer))
                }
                .buttonStyle(.plain)
            } else {
                Button {
                    MelodiousHaptics.heavy()
                    Task {
                        await viewModel.startActivity(activity.id)
                        onOpenRemote?()
                    }
                } label: {
                    HStack(spacing: 4) {
                        if isPending {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "play.fill")
                                .font(.system(size: 11))
                        }
                        Text(isPending ? "Starting…" : "Start")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(MelodiousTheme.onSurface)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(MelodiousTheme.keyRaised))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(isRunning ? MelodiousTheme.runningCard.opacity(0.65) : MelodiousTheme.card)
        )
    }
}
