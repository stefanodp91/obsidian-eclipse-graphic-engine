// ThermalStatePlugin — exposes ProcessInfo thermal + low-power signals to JavaScript
// via Capacitor. Registered automatically by Capacitor plugin discovery (CAPBridgedPlugin).
// Symmetric with the Android ThermalStatePlugin.
//
// JS usage:
//   const ThermalState = registerPlugin('ThermalState');
//   const { state }   = await ThermalState.getState();         // 'nominal'|'fair'|'serious'|'critical'
//   const { enabled } = await ThermalState.getPowerSaveMode();  // Low Power Mode (system-wide)
//   ThermalState.addListener('thermalStateChange', cb) / ('powerSaveModeChange', cb)

import Foundation
import Capacitor

@objc(ThermalStatePlugin)
public class ThermalStatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ThermalStatePlugin"
    public let jsName = "ThermalState"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPowerSaveMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTemperature", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getThermalHeadroom", returnType: CAPPluginReturnPromise),
    ]

    private var thermalObserver: NSObjectProtocol?
    private var powerStateObserver: NSObjectProtocol?

    // Wire the observers in load() (mirrors the Android plugin) so events fire
    // regardless of when JS subscribes. JS subscription itself uses Capacitor's
    // built-in addListener machinery — a custom addListener method would override
    // CAPPlugin's and is not needed.
    override public func load() {
        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.notifyListeners("thermalStateChange", data: ["state": self.thermalStateString()])
        }

        // Low Power Mode toggle (iOS equivalent of Android Battery Saver).
        powerStateObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name.NSProcessInfoPowerStateDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.notifyListeners("powerSaveModeChange",
                                 data: ["enabled": ProcessInfo.processInfo.isLowPowerModeEnabled])
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(["state": thermalStateString()])
    }

    @objc func getPowerSaveMode(_ call: CAPPluginCall) {
        call.resolve(["enabled": ProcessInfo.processInfo.isLowPowerModeEnabled])
    }

    // getTemperature() → { batteryC: null } — platform-honest (the DisplayRefresh
    // pattern): iOS exposes NO temperature at all to a public app (neither
    // battery nor SoC); the iOS thermal signal remains thermalState. The Android
    // mirror returns the real battery temperature in °C.
    @objc func getTemperature(_ call: CAPPluginCall) {
        call.resolve(["batteryC": NSNull()])
    }

    // getThermalHeadroom() → { headroom: null } — platform-honest.
    // Apple exposes no equivalent of PowerManager.getThermalHeadroom: there is no
    // numeric thermal budget and no forecast. The only iOS signal remains
    // ProcessInfo.thermalState, with 4 steps, already exposed by getState().
    // It returns null and NOT 0: a zero would mean "cold device" and would disarm
    // the governor precisely where the signal is missing.
    @objc func getThermalHeadroom(_ call: CAPPluginCall) {
        call.resolve(["headroom": NSNull()])
    }

    deinit {
        if let obs = thermalObserver {
            NotificationCenter.default.removeObserver(obs)
        }
        if let obs = powerStateObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    private func thermalStateString() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal:  return "nominal"
        case .fair:     return "fair"
        case .serious:  return "serious"
        case .critical: return "critical"
        @unknown default: return "nominal"
        }
    }
}
