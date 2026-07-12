package com.v4vmusic.librelistener

import android.content.Intent
import androidx.core.content.FileProvider
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Native share sheet for the APK, used by the wallet's Diagnostics export (see core/native-share.ts).
 * A Capacitor WebView can't export a file the way a browser can — a blob `<a download>` click is a
 * silent no-op and `navigator.share({files})` is unsupported — so the diag export did nothing in the
 * wrapper. This opens the Android system **share sheet** (ACTION_SEND via Intent.createChooser), the
 * direct analog of the iOS share sheet: the user gets the full target list (Nearby Share, email,
 * messaging, Drive, "Save to Files", …) and picks where the log goes.
 *
 * ACTION_SEND requires a content:// URI (a raw file:// path throws FileUriExposedException on API 24+),
 * so the text is written to cacheDir/diagnostics/ and shared through a dedicated FileProvider with
 * authority "${applicationId}.diagfileprovider" (its own <provider> + res/xml/diag_file_paths.xml — see
 * AndroidManifest.snippet.xml; wire-native.mjs adds both to the generated project). A dedicated
 * authority avoids colliding with Capacitor's own ".fileprovider".
 *
 * The web side calls `Capacitor.Plugins.LibreDiagnostics.shareText({ name, contents, mimeType })`.
 *
 * Register in MainActivity.onCreate BEFORE super.onCreate:
 *     registerPlugin(LibreDiagnosticsPlugin::class.java)
 */
@CapacitorPlugin(name = "LibreDiagnostics")
class LibreDiagnosticsPlugin : Plugin() {

    @PluginMethod
    fun shareText(call: PluginCall) {
        val name = call.getString("name") ?: "libre-diagnostics.txt"
        val contents = call.getString("contents") ?: return call.reject("missing contents")
        val mimeType = call.getString("mimeType") ?: "text/plain"
        try {
            // One rolling file, overwritten each export, so the cache doesn't grow unbounded.
            val dir = File(context.cacheDir, "diagnostics").apply { mkdirs() }
            val file = File(dir, name)
            file.writeText(contents, Charsets.UTF_8)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.diagfileprovider", file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, name)
                putExtra(Intent.EXTRA_TITLE, name)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, "Share diagnostics").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(chooser)
            call.resolve()
        } catch (e: Exception) {
            call.reject("share failed: ${e.message}")
        }
    }
}
