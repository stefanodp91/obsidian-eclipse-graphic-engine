package com.obsidian.eclipse.capacitorplugins;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * ThermalStatePlugin — exposes PowerManager thermal + power-save signals to JS via Capacitor.
 * Mirror of iOS ThermalStatePlugin.swift. JS API:
 *   getState()          → { state: 'nominal' | 'fair' | 'serious' | 'critical' }
 *   addListener('thermalStateChange', cb)
 *   getPowerSaveMode()  → { enabled: boolean }   // Battery Saver (system-wide)
 *   addListener('powerSaveModeChange', cb)       // { enabled: boolean }
 *
 * Thermal requires API 29+ (Android 10) — falls back to "nominal" on older devices.
 * Power-save (isPowerSaveMode + ACTION_POWER_SAVE_MODE_CHANGED) is API 21+.
 * Target devices (Pixel 4 = API 33, Galaxy A25 = API 34, Pixel 9 Pro = API 34) all support both.
 *
 * Fase 4b: lives in the obsidian-eclipse-capacitor-plugins package; auto-registered
 * by Capacitor via `cap sync` (no manual registerPlugin in the host MainActivity).
 */
@CapacitorPlugin(name = "ThermalState")
public class ThermalStatePlugin extends Plugin {

    private PowerManager powerManager;
    private PowerManager.OnThermalStatusChangedListener thermalListener;
    private BroadcastReceiver powerSaveReceiver;

    @Override
    public void load() {
        Context ctx = getContext();
        powerManager = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && powerManager != null) {
            thermalListener = status -> {
                JSObject data = new JSObject();
                data.put("state", mapStatus(status));
                notifyListeners("thermalStateChange", data);
            };
            powerManager.addThermalStatusListener(thermalListener);
        }

        // Battery Saver toggle: system broadcasts ACTION_POWER_SAVE_MODE_CHANGED
        // (API 21+) whenever the user (or the OS auto-rule) flips power-save.
        if (powerManager != null) {
            powerSaveReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    JSObject data = new JSObject();
                    data.put("enabled", powerManager.isPowerSaveMode());
                    notifyListeners("powerSaveModeChange", data);
                }
            };
            ctx.registerReceiver(powerSaveReceiver,
                    new IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED));
        }
    }

    @PluginMethod
    public void getState(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("state", currentState());
        call.resolve(ret);
    }

    @PluginMethod
    public void getPowerSaveMode(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", powerManager != null && powerManager.isPowerSaveMode());
        call.resolve(ret);
    }

    /**
     * getTemperature() → { batteryC: number | null }
     * Battery temperature in °C from the sticky ACTION_BATTERY_CHANGED intent
     * (EXTRA_TEMPERATURE, tenths of °C) — the only device temperature Android
     * exposes to non-privileged apps (CPU/skin need HardwarePropertiesManager,
     * device-owner only). Perf HUD observability (owner 2026-07-13).
     * iOS mirror is platform-honest: no public temperature API → batteryC null
     * (same pattern as DisplayRefresh's no-op setRefreshMode).
     */
    @PluginMethod
    public void getTemperature(PluginCall call) {
        JSObject ret = new JSObject();
        Intent battery = getContext().registerReceiver(null,
                new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int tenths = battery != null
                ? battery.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE)
                : Integer.MIN_VALUE;
        if (tenths == Integer.MIN_VALUE) ret.put("batteryC", JSObject.NULL);
        else ret.put("batteryC", tenths / 10.0);
        call.resolve(ret);
    }

    /**
     * getThermalHeadroom(forecastSeconds) → { headroom: number | null }
     *
     * PowerManager.getThermalHeadroom (API 30+): 0..1 = frazione del budget
     * termico consumata, con 1.0 = throttling severo. È l'unico segnale
     * CONTINUO e soprattutto PREDITTIVO che Android espone: `getCurrentThermalStatus`
     * è a gradini e arriva quando il device sta già limitando (misurato: MODERATE
     * dopo 16 minuti di gioco, SEVERE dopo 22 con high-refresh ON).
     *
     * Ritorna null quando il valore non è disponibile: API < 30, oppure NaN —
     * l'OS restituisce NaN se lo si interroga troppo spesso (il contratto chiede
     * un minimo di ~10s fra le chiamate) o se il device non lo implementa.
     * null significa "non lo so", MAI 0: uno zero verrebbe letto come "device
     * freddo" e disarmerebbe il governor proprio dove il segnale manca.
     */
    /**
     * Intervallo minimo fra due letture reali, dal contratto dell'API: sotto i
     * ~10s l'OS restituisce NaN. Il rate-limit sta ANCHE qui, e non solo nel
     * facade TS, perché la finestra è di processo: due chiamanti JS distinti
     * (governor + PerfHud) rispettano ciascuno il proprio intervallo e insieme
     * violano quello dell'OS. Il risultato sarebbe un NaN → null letto come
     * "segnale non disponibile", cioè un governor termico disarmato da un
     * eccesso di zelo nel misurarlo.
     */
    private static final long HEADROOM_MIN_INTERVAL_MS = 11_000L;

    private long headroomLastAtMs = 0L;
    private Float headroomLastValue = null;
    private int headroomLastForecast = -1;

    @PluginMethod
    public void getThermalHeadroom(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || powerManager == null) {
            ret.put("headroom", JSObject.NULL);
            call.resolve(ret);
            return;
        }
        int forecast = call.getInt("forecastSeconds", 0);
        long now = android.os.SystemClock.elapsedRealtime();
        boolean withinWindow = forecast == headroomLastForecast
                && headroomLastAtMs != 0L
                && (now - headroomLastAtMs) < HEADROOM_MIN_INTERVAL_MS;

        if (withinWindow) {
            // Ultimo valore BUONO invece di un null autoinflitto.
            if (headroomLastValue == null) ret.put("headroom", JSObject.NULL);
            else ret.put("headroom", (double) headroomLastValue.floatValue());
            call.resolve(ret);
            return;
        }

        try {
            float h = powerManager.getThermalHeadroom(forecast);
            if (Float.isNaN(h) || Float.isInfinite(h)) {
                headroomLastValue = null;
                ret.put("headroom", JSObject.NULL);
            } else {
                headroomLastValue = h;
                ret.put("headroom", (double) h);
            }
            headroomLastAtMs = now;
            headroomLastForecast = forecast;
        } catch (Exception e) {
            ret.put("headroom", JSObject.NULL);
        }
        call.resolve(ret);
    }

    // NOTE: no custom addListener here. Overriding Capacitor's built-in
    // addListener (as the prior version did) shadows it — the JS subscription is
    // never registered, keepAlive is never set, and notifyListeners has no
    // listener, so thermalStateChange events were silently dead on Android. The
    // observer wired in load() + Capacitor's built-in addListener deliver events
    // correctly (matches the iOS plugin + NativeGyro).

    @Override
    protected void handleOnDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && powerManager != null
                && thermalListener != null) {
            powerManager.removeThermalStatusListener(thermalListener);
            thermalListener = null;
        }
        if (powerSaveReceiver != null) {
            try { getContext().unregisterReceiver(powerSaveReceiver); }
            catch (IllegalArgumentException ignored) { /* already unregistered */ }
            powerSaveReceiver = null;
        }
        super.handleOnDestroy();
    }

    private String currentState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || powerManager == null) {
            return "nominal";
        }
        return mapStatus(powerManager.getCurrentThermalStatus());
    }

    private static String mapStatus(int status) {
        switch (status) {
            case PowerManager.THERMAL_STATUS_NONE:
            case PowerManager.THERMAL_STATUS_LIGHT:
                return "nominal";
            case PowerManager.THERMAL_STATUS_MODERATE:
                return "fair";
            case PowerManager.THERMAL_STATUS_SEVERE:
                return "serious";
            // Termica S6.1: CRITICAL non è più collassato in "serious". Prima
            // "critical" si raggiungeva solo a EMERGENCY/SHUTDOWN, cioè a
            // spegnimento imminente — un livello di fatto irraggiungibile, che
            // rendeva inerti sia il trim massimo del governor sia il trigger di
            // re-probe `thermal=critical` di DeviceProbe.
            case PowerManager.THERMAL_STATUS_CRITICAL:
            case PowerManager.THERMAL_STATUS_EMERGENCY:
            case PowerManager.THERMAL_STATUS_SHUTDOWN:
                return "critical";
            default:
                return "nominal";
        }
    }
}
