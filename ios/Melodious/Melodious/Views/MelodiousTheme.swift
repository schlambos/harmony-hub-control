import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Color palette and design tokens from `DESIGN.md` (`tokens.css` / `MelodiousTheme.kt`).
public enum MelodiousTheme {
    public static let canvas = Color(red: 0x0E / 255.0, green: 0x10 / 255.0, blue: 0x14 / 255.0)
    public static let navBar = Color(red: 0x15 / 255.0, green: 0x18 / 255.0, blue: 0x1D / 255.0)
    public static let card = Color(red: 0x17 / 255.0, green: 0x1A / 255.0, blue: 0x20 / 255.0)
    public static let key = Color(red: 0x1F / 255.0, green: 0x23 / 255.0, blue: 0x2B / 255.0)
    public static let keyRaised = Color(red: 0x2A / 255.0, green: 0x2F / 255.0, blue: 0x39 / 255.0)
    public static let dpadRing = Color(red: 0x1A / 255.0, green: 0x1E / 255.0, blue: 0x25 / 255.0)
    public static let divider = Color(red: 0x22 / 255.0, green: 0x26 / 255.0, blue: 0x2E / 255.0)
    public static let live = Color(red: 0x6F / 255.0, green: 0xD3 / 255.0, blue: 0xA8 / 255.0)
    public static let warning = Color(red: 0xF2 / 255.0, green: 0xC4 / 255.0, blue: 0x8D / 255.0)
    public static let powerContainer = Color(red: 0x3A / 255.0, green: 0x1F / 255.0, blue: 0x1F / 255.0)
    public static let onPowerContainer = Color(red: 0xFF / 255.0, green: 0xB4 / 255.0, blue: 0xAB / 255.0)
    public static let runningCard = Color(red: 0x1D / 255.0, green: 0x28 / 255.0, blue: 0x40 / 255.0)

    public static let keyRed = Color(red: 0xF0 / 255.0, green: 0x6A / 255.0, blue: 0x6A / 255.0)
    public static let keyGreen = Color(red: 0x5F / 255.0, green: 0xD0 / 255.0, blue: 0x8B / 255.0)
    public static let keyYellow = Color(red: 0xF2 / 255.0, green: 0xD2 / 255.0, blue: 0x5C / 255.0)
    public static let keyBlue = Color(red: 0x6A / 255.0, green: 0xA2 / 255.0, blue: 0xF5 / 255.0)

    public static let primary = Color(red: 0x9D / 255.0, green: 0xB8 / 255.0, blue: 0xFF / 255.0)
    public static let onPrimary = Color(red: 0x0B / 255.0, green: 0x1A / 255.0, blue: 0x3A / 255.0)
    public static let primaryContainer = Color(red: 0x2B / 255.0, green: 0x3A / 255.0, blue: 0x5E / 255.0)
    public static let onPrimaryContainer = Color(red: 0xD9 / 255.0, green: 0xE2 / 255.0, blue: 0xFF / 255.0)

    public static let onSurface = Color(red: 0xE7 / 255.0, green: 0xE9 / 255.0, blue: 0xEE / 255.0)
    public static let onSurfaceVariant = Color(red: 0xA3 / 255.0, green: 0xAA / 255.0, blue: 0xB7 / 255.0)
    public static let surfaceHigh = Color(red: 0x1A / 255.0, green: 0x1D / 255.0, blue: 0x23 / 255.0)
    public static let surfaceHighest = Color(red: 0x26 / 255.0, green: 0x2A / 255.0, blue: 0x33 / 255.0)
    public static let outline = Color(red: 0x4A / 255.0, green: 0x50 / 255.0, blue: 0x5C / 255.0)
}

@MainActor
public enum MelodiousHaptics {
    public static func tap() {
        #if canImport(UIKit) && os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }

    public static func heavy() {
        #if canImport(UIKit) && os(iOS)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        #endif
    }
}

public struct LiveStatusDot: View {
    public let isLive: Bool

    public init(isLive: Bool = true) {
        self.isLive = isLive
    }

    public var body: some View {
        Circle()
            .fill(isLive ? MelodiousTheme.live : MelodiousTheme.outline)
            .frame(width: 8, height: 8)
    }
}

/// An activity's tile: its own icon when the hub holds one, else the symbol
/// for its kind (also while the image loads). docs/REMOTE_IMAGES.md
public struct ActivityTileView: View {
    public let activity: HubActivity
    /// Not observed: the tile only asks it for the image, and shouldn't redraw
    /// on every change the view model publishes.
    public let viewModel: HubViewModel
    public let isActive: Bool
    public let size: CGFloat
    @State private var image: UIImage?

    public init(activity: HubActivity, viewModel: HubViewModel, isActive: Bool = false, size: CGFloat = 44) {
        self.activity = activity
        self.viewModel = viewModel
        self.isActive = isActive
        self.size = size
    }

    public var body: some View {
        Group {
            if let image = image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
            } else {
                IconTileView(systemName: activity.systemIconName, isActive: isActive, size: size)
            }
        }
        .task(id: activity.imageName) {
            image = await viewModel.activityImage(activity)
        }
    }
}

public struct IconTileView: View {
    public let systemName: String
    public let isActive: Bool
    public let size: CGFloat

    public init(systemName: String, isActive: Bool = false, size: CGFloat = 44) {
        self.systemName = systemName
        self.isActive = isActive
        self.size = size
    }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                .fill(isActive ? MelodiousTheme.primaryContainer : MelodiousTheme.key)
                .frame(width: size, height: size)
            Image(systemName: systemName)
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(isActive ? MelodiousTheme.primary : MelodiousTheme.onSurfaceVariant)
        }
    }
}
