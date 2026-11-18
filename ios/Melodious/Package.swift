// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Melodious",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Melodious", targets: ["Melodious"])
    ],
    targets: [
        .target(
            name: "Melodious",
            path: "Melodious",
            exclude: [
                "Info.plist",
                "Assets.xcassets"
            ]
        ),
        .testTarget(
            name: "MelodiousTests",
            dependencies: ["Melodious"],
            path: "MelodiousTests"
        )
    ]
)
