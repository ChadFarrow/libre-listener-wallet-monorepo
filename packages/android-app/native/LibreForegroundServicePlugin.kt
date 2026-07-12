package com.v4vmusic.librelistener

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor bridge for the background keep-alive. The web app calls
 * `Capacitor.Plugins.LibreForegroundService.start()/stop()` (see core/native-bridge.ts
 * `createNativeKeepAlive`), driven by the wallet's node run-state.
 *
 * Register this in MainActivity.onCreate BEFORE super.onCreate:
 *     registerPlugin(LibreForegroundServicePlugin::class.java)
 */
@CapacitorPlugin(name = "LibreForegroundService")
class LibreForegroundServicePlugin : Plugin() {
    @PluginMethod
    fun start(call: PluginCall) {
        ForegroundService.start(context)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        ForegroundService.stop(context)
        call.resolve()
    }
}
