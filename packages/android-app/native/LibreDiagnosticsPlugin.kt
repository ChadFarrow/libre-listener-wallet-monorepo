package com.v4vmusic.librelistener

import android.content.Intent
import androidx.activity.result.ActivityResult
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Native "save a text file" for the APK, used by the wallet's Diagnostics export (see
 * core/native-share.ts). A Capacitor WebView can't export a file the way a browser can — a blob
 * `<a download>` click is a silent no-op and `navigator.share({files})` is unsupported — so the diag
 * export button did nothing in the wrapper. This opens the OS Storage-Access-Framework "Save document"
 * dialog (ACTION_CREATE_DOCUMENT), the same SAF approach as LibreBackupStoragePlugin, and writes the
 * text to wherever the user picks (local storage, Files, Drive, …). No FileProvider / manifest changes
 * needed — SAF hands back a write URI directly.
 *
 * The web side calls `Capacitor.Plugins.LibreDiagnostics.saveText({ name, contents, mimeType })`.
 *
 * Register in MainActivity.onCreate BEFORE super.onCreate:
 *     registerPlugin(LibreDiagnosticsPlugin::class.java)
 */
@CapacitorPlugin(name = "LibreDiagnostics")
class LibreDiagnosticsPlugin : Plugin() {

    @PluginMethod
    fun saveText(call: PluginCall) {
        val name = call.getString("name") ?: "libre-diagnostics.txt"
        if (call.getString("contents") == null) return call.reject("missing contents")
        val mimeType = call.getString("mimeType") ?: "text/plain"
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, name)
        }
        // Capacitor persists `call` (including its options) across the activity result, so the
        // callback can read `contents` back off the saved call.
        startActivityForResult(call, intent, "onDocumentCreated")
    }

    @ActivityCallback
    private fun onDocumentCreated(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (uri == null) {
            // User dismissed the dialog — surface as a cancel so the web side stays silent (matches the
            // Web Share cancel handling), not an error toast.
            call.reject("cancelled")
            return
        }
        val contents = call.getString("contents") ?: return call.reject("missing contents")
        try {
            context.contentResolver.openOutputStream(uri, "wt").use { out ->
                out?.write(contents.toByteArray(Charsets.UTF_8)) ?: return call.reject("no output stream")
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject("save failed: ${e.message}")
        }
    }
}
