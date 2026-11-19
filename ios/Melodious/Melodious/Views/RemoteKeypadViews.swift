import SwiftUI

/// Interactive remote key that supports immediate press-down, hold-to-repeat, long-press actions,
/// and slide-off cancellation.
public struct RemoteKeyButton<Content: View>: View {
    @ObservedObject public var viewModel: HubViewModel
    public let target: RemoteTarget
    public let buttonKey: String
    public let label: String
    public var cornerRadius: CGFloat = 16
    public var isCircle: Bool = false
    public var baseColor: Color = MelodiousTheme.key
    public var pressedColor: Color = MelodiousTheme.keyRaised
    @ViewBuilder public let content: () -> Content

    @State private var isPressed: Bool = false

    public init(
        viewModel: HubViewModel,
        target: RemoteTarget,
        buttonKey: String,
        label: String,
        cornerRadius: CGFloat = 16,
        isCircle: Bool = false,
        baseColor: Color = MelodiousTheme.key,
        pressedColor: Color = MelodiousTheme.keyRaised,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.viewModel = viewModel
        self.target = target
        self.buttonKey = buttonKey
        self.label = label
        self.cornerRadius = cornerRadius
        self.isCircle = isCircle
        self.baseColor = baseColor
        self.pressedColor = pressedColor
        self.content = content
    }

    private var resolvedAction: ResolvedButtonAction? {
        viewModel.keyMap(for: target)[buttonKey]
    }

    private var isMapped: Bool {
        resolvedAction != nil
    }

    private var hasHoldDot: Bool {
        resolvedAction?.hasHold == true
    }

    public var body: some View {
        GeometryReader { geo in
            ZStack {
                if isCircle {
                    Circle()
                        .fill(isPressed ? pressedColor : baseColor)
                } else {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(isPressed ? pressedColor : baseColor)
                }

                content()
                    .foregroundStyle(MelodiousTheme.onSurface)

                if hasHoldDot {
                    VStack {
                        HStack {
                            Spacer()
                            Circle()
                                .fill(MelodiousTheme.primary.opacity(0.85))
                                .frame(width: 5, height: 5)
                                .padding(7)
                        }
                        Spacer()
                    }
                }
            }
            .opacity(isMapped ? 1.0 : 0.35)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard isMapped else { return }
                        let inside = value.location.x >= -12 &&
                                     value.location.x <= geo.size.width + 12 &&
                                     value.location.y >= -12 &&
                                     value.location.y <= geo.size.height + 12
                        if !isPressed && inside {
                            isPressed = true
                            MelodiousHaptics.tap()
                            viewModel.handleKeyTouchDown(target: target, buttonKey: buttonKey)
                        } else if isPressed && !inside {
                            isPressed = false
                            viewModel.handleKeyTouchUp(target: target, buttonKey: buttonKey, cancelled: true)
                        }
                    }
                    .onEnded { value in
                        guard isMapped else { return }
                        let inside = value.location.x >= -12 &&
                                     value.location.x <= geo.size.width + 12 &&
                                     value.location.y >= -12 &&
                                     value.location.y <= geo.size.height + 12
                        if isPressed {
                            isPressed = false
                            viewModel.handleKeyTouchUp(target: target, buttonKey: buttonKey, cancelled: !inside)
                        }
                    }
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityDescription)
            .accessibilityAddTraits(.isButton)
        }
    }

    private var accessibilityDescription: String {
        if let action = resolvedAction {
            return "\(label), sends \(action.pressCommand) to \(action.pressDeviceName)"
        }
        return "\(label), unmapped"
    }
}

/// Circular 5-way D-Pad (DirectionUp, DirectionDown, DirectionLeft, DirectionRight, Select/OK).
public struct RemoteDPadView: View {
    @ObservedObject public var viewModel: HubViewModel
    public let target: RemoteTarget
    public var diameter: CGFloat = 236

    public init(viewModel: HubViewModel, target: RemoteTarget, diameter: CGFloat = 236) {
        self.viewModel = viewModel
        self.target = target
        self.diameter = diameter
    }

    public var body: some View {
        let armSize = diameter * 0.31
        let okSize = diameter * 0.38
        let offset = diameter * 0.31

        ZStack {
            Circle()
                .fill(MelodiousTheme.dpadRing)
                .frame(width: diameter, height: diameter)
                .overlay(
                    Circle()
                        .strokeBorder(MelodiousTheme.divider, lineWidth: 1)
                )

            // Up
            RemoteKeyButton(
                viewModel: viewModel,
                target: target,
                buttonKey: "DirectionUp",
                label: "Up",
                isCircle: true,
                baseColor: .clear,
                pressedColor: MelodiousTheme.keyRaised
            ) {
                Image(systemName: "chevron.up")
                    .font(.system(size: 22, weight: .bold))
            }
            .frame(width: armSize, height: armSize)
            .offset(y: -offset)

            // Down
            RemoteKeyButton(
                viewModel: viewModel,
                target: target,
                buttonKey: "DirectionDown",
                label: "Down",
                isCircle: true,
                baseColor: .clear,
                pressedColor: MelodiousTheme.keyRaised
            ) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 22, weight: .bold))
            }
            .frame(width: armSize, height: armSize)
            .offset(y: offset)

            // Left
            RemoteKeyButton(
                viewModel: viewModel,
                target: target,
                buttonKey: "DirectionLeft",
                label: "Left",
                isCircle: true,
                baseColor: .clear,
                pressedColor: MelodiousTheme.keyRaised
            ) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 22, weight: .bold))
            }
            .frame(width: armSize, height: armSize)
            .offset(x: -offset)

            // Right
            RemoteKeyButton(
                viewModel: viewModel,
                target: target,
                buttonKey: "DirectionRight",
                label: "Right",
                isCircle: true,
                baseColor: .clear,
                pressedColor: MelodiousTheme.keyRaised
            ) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 22, weight: .bold))
            }
            .frame(width: armSize, height: armSize)
            .offset(x: offset)

            // Center OK / Select
            RemoteKeyButton(
                viewModel: viewModel,
                target: target,
                buttonKey: "Select",
                label: "OK",
                isCircle: true,
                baseColor: MelodiousTheme.keyRaised,
                pressedColor: MelodiousTheme.primaryContainer
            ) {
                Text("OK")
                    .font(.system(size: 18, weight: .semibold))
            }
            .frame(width: okSize, height: okSize)
        }
        .frame(width: diameter, height: diameter)
    }
}

/// Vertical rocker for Volume (`VolumeUp` / `VolumeDown`) or Channel (`ChannelUp` / `ChannelDown`).
public struct RemoteRockerView: View {
    @ObservedObject public var viewModel: HubViewModel
    public let target: RemoteTarget
    public let upKey: String
    public let downKey: String
    public let upLabel: String
    public let downLabel: String
    public let caption: String
    public let useChevron: Bool

    public init(
        viewModel: HubViewModel,
        target: RemoteTarget,
        upKey: String,
        downKey: String,
        upLabel: String,
        downLabel: String,
        caption: String,
        useChevron: Bool = false
    ) {
        self.viewModel = viewModel
        self.target = target
        self.upKey = upKey
        self.downKey = downKey
        self.upLabel = upLabel
        self.downLabel = downLabel
        self.caption = caption
        self.useChevron = useChevron
    }

    public var body: some View {
        VStack(spacing: 0) {
            RemoteKeyButton(
                viewModel: viewModel,
                target: target,
                buttonKey: upKey,
                label: upLabel,
                cornerRadius: 28
            ) {
                Image(systemName: useChevron ? "chevron.up" : "plus")
                    .font(.system(size: 20, weight: .semibold))
            }
            .frame(maxHeight: .infinity)

            Text(caption)
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.0)
                .foregroundStyle(MelodiousTheme.onSurfaceVariant)
                .padding(.vertical, 4)

            RemoteKeyButton(
                viewModel: viewModel,
                target: target,
                buttonKey: downKey,
                label: downLabel,
                cornerRadius: 28
            ) {
                Image(systemName: useChevron ? "chevron.down" : "minus")
                    .font(.system(size: 20, weight: .semibold))
            }
            .frame(maxHeight: .infinity)
        }
        .frame(width: 68)
        .background(
            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .fill(MelodiousTheme.key)
        )
        .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
    }
}

/// Colour key row (`Red`, `Green`, `Yellow`, `Blue`).
public struct RemoteColorKeysRow: View {
    @ObservedObject public var viewModel: HubViewModel
    public let target: RemoteTarget

    public init(viewModel: HubViewModel, target: RemoteTarget) {
        self.viewModel = viewModel
        self.target = target
    }

    private let items: [(key: String, color: Color)] = [
        ("Red", MelodiousTheme.keyRed),
        ("Green", MelodiousTheme.keyGreen),
        ("Yellow", MelodiousTheme.keyYellow),
        ("Blue", MelodiousTheme.keyBlue)
    ]

    public var body: some View {
        HStack(spacing: 8) {
            ForEach(items, id: \.key) { item in
                RemoteKeyButton(
                    viewModel: viewModel,
                    target: target,
                    buttonKey: item.key,
                    label: item.key,
                    cornerRadius: 14,
                    baseColor: MelodiousTheme.surfaceHighest
                ) {
                    Capsule()
                        .fill(item.color)
                        .frame(width: 30, height: 6)
                }
                .frame(height: 38)
            }
        }
    }
}

/// Standard 4x3 Number Pad (`1`..`9`, `–`, `0`, `Enter`).
public struct RemoteNumberPadGrid: View {
    @ObservedObject public var viewModel: HubViewModel
    public let target: RemoteTarget
    public var keyHeight: CGFloat = 48

    public init(viewModel: HubViewModel, target: RemoteTarget, keyHeight: CGFloat = 48) {
        self.viewModel = viewModel
        self.target = target
        self.keyHeight = keyHeight
    }

    private let rows: [[(key: String, label: String)]] = [
        [("Number1", "1"), ("Number2", "2"), ("Number3", "3")],
        [("Number4", "4"), ("Number5", "5"), ("Number6", "6")],
        [("Number7", "7"), ("Number8", "8"), ("Number9", "9")],
        [("Dash", "–"), ("Number0", "0"), ("Enter", "Enter")]
    ]

    public var body: some View {
        VStack(spacing: 8) {
            ForEach(0..<rows.count, id: \.self) { rowIdx in
                HStack(spacing: 8) {
                    ForEach(rows[rowIdx], id: \.key) { item in
                        RemoteKeyButton(
                            viewModel: viewModel,
                            target: target,
                            buttonKey: item.key,
                            label: item.label,
                            cornerRadius: 14,
                            baseColor: MelodiousTheme.surfaceHighest
                        ) {
                            Text(item.label)
                                .font(.system(size: item.label.count > 1 ? 14 : 20, weight: .medium))
                        }
                        .frame(height: keyHeight)
                    }
                }
            }
        }
    }
}
