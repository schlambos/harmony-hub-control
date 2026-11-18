import SwiftUI

#if !SWIFT_PACKAGE
@main
#endif
public struct MelodiousApp: App {
    @StateObject private var viewModel = HubViewModel()

    public init() {}

    public var body: some Scene {
        WindowGroup {
            ContentView(viewModel: viewModel)
                .onAppear {
                    viewModel.start()
                }
        }
    }
}
