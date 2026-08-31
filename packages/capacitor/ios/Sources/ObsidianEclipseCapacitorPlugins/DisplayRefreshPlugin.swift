// DisplayRefreshPlugin (iOS) — symmetric with the Android DisplayRefreshPlugin
// (Fase 4c). API parity: setRefreshMode('60'|'max'), getRefreshInfo().
//
// Platform-honest behavior: iOS ProMotion is system-adaptive and WKWebView's
// frame rate is governed by the app's Info.plist CADisableMinimumFrameDurationOnPhone
// (build-time) plus the JS engine.maxFPS lever (attachRefreshPreference uses
// engine.maxFPS on iOS, the native display-mode pin only on Android). So there is
// NO runtime panel pin to set here: setRefreshMode resolves as a no-op for API
// parity, while getRefreshInfo reports the REAL panel capability so the JS layer
// can show the correct max Hz on iOS too.

import Foundation
import Capacitor
import UIKit

@objc(DisplayRefreshPlugin)
public class DisplayRefreshPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DisplayRefreshPlugin"
    public let jsName = "DisplayRefresh"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setRefreshMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRefreshInfo", returnType: CAPPluginReturnPromise),
    ]

    @objc func setRefreshMode(_ call: CAPPluginCall) {
        // No-op on iOS (ProMotion adaptive; refresh controlled via engine.maxFPS
        // JS-side). Resolve for parity with Android.
        let mode = call.getString("mode") ?? "60"
        call.resolve(["mode": mode])
    }

    @objc func getRefreshInfo(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let maxHz = UIScreen.main.maximumFramesPerSecond
            var supported: [Int] = [60]
            if maxHz != 60 { supported.append(maxHz) }
            call.resolve([
                "maxHz": maxHz,
                "currentHz": maxHz,
                "supported": supported,
            ])
        }
    }
}
