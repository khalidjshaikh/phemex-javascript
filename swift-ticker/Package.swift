// swift-tools-version: 5.7
import PackageDescription

let package = Package(
    name: "phemex-ws-ticker",
    platforms: [.macOS(.v10_15)],
    targets: [
        .executableTarget(name: "phemex-ws-ticker", path: "Sources")
    ]
)