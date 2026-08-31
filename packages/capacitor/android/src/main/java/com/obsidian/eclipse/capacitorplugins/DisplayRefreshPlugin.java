package com.obsidian.eclipse.capacitorplugins;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import android.view.Display;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * DisplayRefreshPlugin — lets the web layer opt into the panel's maximum refresh
 * rate (e.g. 120 Hz) at runtime, and query the device's real capability.
 *
 * Self-contained and decoupled from the host Activity. The plugin owns
 * the prefs keys AND the window-pin logic ({@link #applyRefreshPin(Activity, String)},
 * static so the host can call it for cold-start before JS boots). It persists the
 * chosen mode to SharedPreferences ("obsidian_eclipse_display"/"refresh_mode") and re-pins via
 * getActivity().getWindow() — no reference to any host Activity class.
 *
 * A host Activity may call applyRefreshPin(this, ...) at onAttachedToWindow /
 * onWindowFocusChanged so the persisted mode survives cold start with no 60→120
 * flash.
 */
@CapacitorPlugin(name = "DisplayRefresh")
public class DisplayRefreshPlugin extends Plugin {

    private static final String TAG = "OE-DisplayRefresh";

    public static final String PREFS_NAME = "obsidian_eclipse_display";
    public static final String PREF_REFRESH_MODE = "refresh_mode";
    public static final String MODE_60 = "60";
    public static final String MODE_MAX = "max";

    @PluginMethod
    public void setRefreshMode(PluginCall call) {
        String mode = call.getString("mode", MODE_60);
        if (!MODE_60.equals(mode) && !MODE_MAX.equals(mode)) {
            call.reject("invalid mode: " + mode);
            return;
        }
        Context ctx = getContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(PREF_REFRESH_MODE, mode).apply();

        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> applyRefreshPin(activity, "setRefreshMode"));
        }
        Log.i(TAG, "setRefreshMode=" + mode);

        JSObject ret = new JSObject();
        ret.put("mode", mode);
        call.resolve(ret);
    }

    @PluginMethod
    public void getRefreshInfo(PluginCall call) {
        Display display = null;
        Activity activity = getActivity();
        if (activity != null && activity.getWindow() != null
            && activity.getWindow().getDecorView() != null) {
            display = activity.getWindow().getDecorView().getDisplay();
        }
        if (display == null) {
            call.reject("display unavailable");
            return;
        }

        Display.Mode current = display.getMode();
        Display.Mode[] modes = display.getSupportedModes();
        float maxHz = 0f;
        Set<Integer> supported = new LinkedHashSet<>();
        for (Display.Mode m : modes) {
            float hz = m.getRefreshRate();
            if (hz > maxHz) maxHz = hz;
            supported.add(Math.round(hz));
        }

        JSArray arr = new JSArray();
        for (Integer hz : supported) arr.put(hz.intValue());

        JSObject ret = new JSObject();
        ret.put("maxHz", Math.round(maxHz));
        ret.put("currentHz", Math.round(current.getRefreshRate()));
        ret.put("supported", arr);
        call.resolve(ret);
    }

    private static String readMode(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String mode = prefs.getString(PREF_REFRESH_MODE, MODE_60);
        return MODE_MAX.equals(mode) ? MODE_MAX : MODE_60;
    }

    /**
     * Read the stored refresh mode and pin the activity window. Static + Activity-
     * generic so the host calls it for cold-start (already on the UI thread at
     * onAttachedToWindow / onWindowFocusChanged). MUST run on the UI thread.
     *
     * Default ("60") keeps rAF on a stable 16.6 ms cadence (battery-first; LTPO
     * would otherwise throttle rAF erratically). "max" picks the highest refresh
     * at the CURRENT resolution.
     *
     * Samsung A25 quirk: at onAttachedToWindow the WindowManager has not yet
     * applied the policy switch — getSupportedModes() can return only the active
     * mode, so the lookup can miss. The host applies at BOTH onAttachedToWindow
     * AND onWindowFocusChanged (latter fires after policy + display settle).
     */
    public static void applyRefreshPin(Activity activity, String origin) {
        if (activity == null || activity.getWindow() == null) return;
        boolean wantMax = MODE_MAX.equals(readMode(activity));
        WindowManager.LayoutParams params = activity.getWindow().getAttributes();

        Display display = activity.getWindow().getDecorView() != null
            ? activity.getWindow().getDecorView().getDisplay() : null;
        if (display == null) {
            params.preferredRefreshRate = wantMax ? 0f : 60.0f;
            Log.w(TAG, origin + ": display=null, hint-only mode=" + (wantMax ? "max" : "60"));
            activity.getWindow().setAttributes(params);
            return;
        }

        Display.Mode[] modes = display.getSupportedModes();
        Display.Mode best;
        if (wantMax) {
            best = pickMaxRefreshAtCurrentResolution(display, modes);
            params.preferredRefreshRate = best != null ? best.getRefreshRate() : 0f;
        } else {
            best = pickSixtyHzHighestResolution(modes);
            params.preferredRefreshRate = 60.0f;
        }

        if (best != null) {
            params.preferredDisplayModeId = best.getModeId();
            Log.i(TAG, origin + ": pinned modeId=" + best.getModeId()
                + " " + best.getPhysicalWidth() + "x" + best.getPhysicalHeight()
                + "@" + best.getRefreshRate() + "Hz");
        } else {
            params.preferredDisplayModeId = 0;
            Log.w(TAG, origin + ": no matching mode for " + (wantMax ? "max" : "60") + "Hz; hint-only");
        }
        activity.getWindow().setAttributes(params);
    }

    /** ~60 Hz mode at the highest available resolution (battery-first default). */
    private static Display.Mode pickSixtyHzHighestResolution(Display.Mode[] modes) {
        Display.Mode best = null;
        for (Display.Mode m : modes) {
            if (Math.abs(m.getRefreshRate() - 60.0f) > 1.0f) continue;
            if (best == null
                || m.getPhysicalWidth() * m.getPhysicalHeight()
                   > best.getPhysicalWidth() * best.getPhysicalHeight()) {
                best = m;
            }
        }
        return best;
    }

    /** Highest refresh rate available at the CURRENT resolution. */
    private static Display.Mode pickMaxRefreshAtCurrentResolution(Display display, Display.Mode[] modes) {
        Display.Mode current = display.getMode();
        int targetRes = current.getPhysicalWidth() * current.getPhysicalHeight();
        Display.Mode best = null;
        for (Display.Mode m : modes) {
            if (m.getPhysicalWidth() * m.getPhysicalHeight() != targetRes) continue;
            if (best == null || m.getRefreshRate() > best.getRefreshRate()) {
                best = m;
            }
        }
        return best;
    }
}
