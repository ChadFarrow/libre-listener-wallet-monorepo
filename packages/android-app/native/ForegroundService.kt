package com.v4vmusic.librelistener

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the app process — and therefore the WebView's LDK WASM node + Nostr relay WebSocket — alive
 * while the app is backgrounded or the screen is off. This is the one thing a browser tab cannot do
 * (the OS freezes it within seconds), and it is what makes NWC boosts settle in the background.
 *
 * Pure AOSP: no Firebase / Google Play Services, so it works on GrapheneOS. Started/stopped from JS
 * via [LibreForegroundServicePlugin], driven by the wallet's node run-state (see the web app's
 * core/native-bridge.ts). It NEVER runs a Lightning node itself — it only keeps the ONE existing
 * in-WebView node alive, so it does not reintroduce the background-node force-close hazard.
 */
class ForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        if (USE_WAKE_LOCK) acquireWakeLock()
        // START_STICKY: if the OS kills us under memory pressure, restart so the node keeps running.
        return START_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LibreListener::NodeKeepAlive").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Wallet running",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps your Lightning wallet online to receive payments." }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Libre Listener is running")
            .setContentText("Staying online to receive Lightning payments.")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "libre_node_keepalive"
        const val NOTIFICATION_ID = 4242

        // Hold a PARTIAL_WAKE_LOCK so the node keeps processing the relay socket in the background.
        //
        // The overlay (WebViewResidency) and this wake lock fix TWO DIFFERENT suspensions, both needed:
        //   - overlay   → stops Chromium freezing the OCCLUDED RENDERER (the node's event loop).
        //   - wake lock → stops DOZE suspending the CPU when on battery + screen-off + idle (Doze
        //                 defers wakeups and cuts the network, stalling the relay regardless of the
        //                 renderer).
        // The 2026-07-12 "overlay alone survives 120s screen-off" proof was run with the phone PLUGGED
        // IN (required to capture the heartbeat over adb/logcat) — and charging DISABLES Doze, so that
        // test never exercised the on-battery path. Dropping the wake lock then regressed background
        // boosts on battery (settle while charging, stall unplugged). Keep it on: correctness for an
        // always-on wallet outweighs the CPU-awake battery cost.
        const val USE_WAKE_LOCK = true

        fun start(context: Context) {
            val intent = Intent(context, ForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ForegroundService::class.java))
        }
    }
}
