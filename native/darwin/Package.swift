// swift-tools-version:5.6

import PackageDescription

let package = Package(
    name: "GuanceElectronNativeBuild",
    platforms: [
        .macOS(.v10_14),
    ],
    products: [
        .library(
            name: "GuanceElectronNative",
            type: .dynamic,
            targets: ["GuanceElectronBridge"]
        ),
    ],
    dependencies: [
        .package(
            url: "https://github.com/GuanceCloud/datakit-ios.git",
            exact: "1.6.8-alpha.1"
        ),
    ],
    targets: [
        .target(
            name: "GuanceElectronBridge",
            dependencies: [
                .product(
                    name: "GuanceElectronWebView",
                    package: "datakit-ios"
                ),
            ],
            path: "NativeBridge",
            publicHeadersPath: "Public",
            linkerSettings: [
                .linkedFramework("AppKit"),
            ]
        ),
    ]
)
