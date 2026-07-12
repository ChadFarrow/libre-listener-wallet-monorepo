package com.v4vmusic.librelistener

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor bridge for the background keep-alive. The web app calls
 * `Capacitor.Plugins.LibreForegroundService.start()/stop()` (see core/native-bridge.ts
 * `createNativeKeepAlive`), driven by the wallet's node run-state.
 *
 * Keeps the node's WebView renderer alive while the app is occluded/backgrounded (proven necessary —
 * Chromium freezes an occluded renderer ~60s after it goes hidden, killing NWC settlement). Two layers:
 *   1. Pin the renderer process priority to IMPORTANT and don't waive it when hidden (~60s grace).
 *   2. Reparent the WebView into a 1x1 always-on-top overlay while backgrounded (WebViewResidency), so
 *      it never reports `visibilityState: hidden` and the freeze timer never starts — indefinite.
 * Layer 2 needs SYSTEM_ALERT_WINDOW; without it we fall back to layer 1's grace window.
 *
 * Register this in MainActivity.onCreate BEFORE super.onCreate:
 *     registerPlugin(LibreForegroundServicePlugin::class.java)
 */
@CapacitorPlugin(name = "LibreForegroundService")
class LibreForegroundServicePlugin : Plugin() {
    private var residency: WebViewResidency? = null
    // Only hold the WebView resident while the node is meant to be running in the background.
    private var residencyEnabled = false

    override fun load() {
        super.load()
        activity?.let { residency = WebViewResidency(it) }
        pinRendererPriority()
    }

    @PluginMethod
    fun start(call: PluginCall) {
        ForegroundService.start(context)
        residencyEnabled = true
        pinRendererPriority()
        keepTimersRunning()
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        ForegroundService.stop(context)
        residencyEnabled = false
        // If we're currently in the overlay, pull back to the activity so nothing is left detached.
        bridge?.webView?.let { residency?.moveToActivity(it) }
        call.resolve()
    }

    @PluginMethod
    fun hasOverlayPermission(call: PluginCall) {
        val res = JSObject()
        res.put("granted", residency?.hasPermission() ?: false)
        call.resolve(res)
    }

    /** Opens the system "draw over other apps" settings for this app so the user can grant it. */
    @PluginMethod
    fun requestOverlayPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !(residency?.hasPermission() ?: true)) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
        call.resolve()
    }

    // Occluded/backgrounded: hold the renderer resident so the node keeps running.
    override fun handleOnPause() {
        super.handleOnPause()
        keepTimersRunning()
        if (residencyEnabled) bridge?.webView?.let { residency?.moveToOverlay(it) }
    }

    override fun handleOnResume() {
        super.handleOnResume()
        bridge?.webView?.let { residency?.moveToActivity(it) }
        keepTimersRunning()
    }

    private fun pinRendererPriority() {
        val webView = bridge?.webView ?: return
        webView.post {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
            }
        }
    }

    private fun keepTimersRunning() {
        val webView = bridge?.webView ?: return
        webView.post { webView.resumeTimers() }
    }
}
