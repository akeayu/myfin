package com.myfin.app;

import android.util.Log;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MyfinSmokeMarker")
public class MyfinSmokeMarkerPlugin extends Plugin {
    private static final String TAG = "MYFIN_ANDROID_SMOKE";

    @PluginMethod
    public void emit(PluginCall call) {
        String message = call.getString("message", "");
        if (message.isEmpty() || message.length() > 512 ||
            !message.matches("[^\\r\\n]{1,512}")) {
            call.reject("Invalid MYFIN smoke marker.");
            return;
        }
        Log.i(TAG, message);
        call.resolve();
    }
}
