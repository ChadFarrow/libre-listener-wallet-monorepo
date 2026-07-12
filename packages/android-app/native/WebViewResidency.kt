package com.v4vmusic.librelistener

import android.app.Activity
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView

/**
 * Keeps the Capacitor WebView "visible" to Chromium while the activity is occluded/backgrounded, so the
 * WebView renderer — and the LDK node + NWC relay loop running inside it — is never frozen.
 *
 * Why: Chromium freezes an occluded WebView renderer ~60s after it goes hidden (proven on-device — see
 * README Phase 0). Renderer-priority pinning only delays that. But a WebView that stays attached to a
 * *visible* window never reports `visibilityState: hidden`, so the freeze timer never starts. We do
 * that by reparenting the WebView, on background, into a 1x1 always-on-top system overlay window
 * (nearly invisible, non-touchable so taps pass through to whatever app is on top). On foreground the
 * WebView is moved back into the activity so the UI renders full-size and normally.
 *
 * Requires SYSTEM_ALERT_WINDOW ("draw over other apps"). If not granted, every call is a safe no-op and
 * behavior falls back to the ~60s renderer-priority grace window.
 */
class WebViewResidency(private val activity: Activity) {
    private var inOverlay = false
    private var originalParent: ViewGroup? = null
    private var originalIndex: Int = -1
    private var originalParams: ViewGroup.LayoutParams? = null

    fun hasPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(activity)

    private fun wm(): WindowManager =
        activity.getSystemService(Activity.WINDOW_SERVICE) as WindowManager

    /** Move the WebView into a 1x1 overlay so it stays "visible" while the activity is backgrounded. */
    fun moveToOverlay(webView: WebView) {
        activity.runOnUiThread {
            if (inOverlay || !hasPermission()) return@runOnUiThread
            val parent = webView.parent as? ViewGroup ?: return@runOnUiThread
            originalParent = parent
            originalIndex = parent.indexOfChild(webView)
            originalParams = webView.layoutParams
            parent.removeView(webView)

            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
            val lp = WindowManager.LayoutParams(
                1, 1, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT,
            )
            lp.gravity = Gravity.TOP or Gravity.START
            try {
                wm().addView(webView, lp)
                inOverlay = true
            } catch (e: Exception) {
                // Re-attach to the activity if the overlay add failed, so the UI isn't left broken.
                restoreToActivity(webView)
            }
        }
    }

    /** Move the WebView back into the activity so the UI renders normally when foregrounded. */
    fun moveToActivity(webView: WebView) {
        activity.runOnUiThread {
            if (!inOverlay) return@runOnUiThread
            inOverlay = false
            // removeViewImmediate() is SYNCHRONOUS — plain removeView() posts the detach, so the
            // WebView's parent is still the overlay when we try to re-add and the re-add is skipped
            // (→ blank activity). Immediate removal clears the parent before we re-attach.
            try { wm().removeViewImmediate(webView) } catch (e: Exception) { /* already detached */ }
            restoreToActivity(webView)
        }
    }

    private fun restoreToActivity(webView: WebView) {
        val parent = originalParent ?: return
        // Defensively detach from whatever it's currently in, then re-add at its original spot.
        (webView.parent as? ViewGroup)?.removeView(webView)
        val idx = if (originalIndex in 0..parent.childCount) originalIndex else -1
        parent.addView(webView, idx, originalParams)
        // Moving a hardware-accelerated WebView between windows can leave it with no rendering surface
        // (blank/black on return). Force the surface + layout to re-establish: toggle visibility across
        // a frame and re-request layout/draw.
        webView.visibility = View.GONE
        webView.post {
            webView.visibility = View.VISIBLE
            webView.requestLayout()
            webView.invalidate()
        }
        originalParent = null
        originalIndex = -1
        originalParams = null
    }
}
