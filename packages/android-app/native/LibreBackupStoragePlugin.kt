package com.v4vmusic.librelistener

import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * SAF-based off-device backup for the APK. Play-Services-FREE: the OS + the chosen cloud app handle
 * auth, so there's no Google OAuth — which Google has deprecated for de-Googled Android (custom-scheme
 * and loopback redirects are gone; the remaining path needs Play Services / App-Links verification).
 * Instead the user picks a folder ONCE via Android's Storage Access Framework (local storage, or Google
 * Drive if its app is installed); we persist the tree URI and write the existing encrypted backup file
 * there. The web side (drive-integration's native path) drives this via Capacitor.Plugins.LibreBackupStorage.
 *
 * Needs `androidx.documentfile:documentfile` in the app module and registration in MainActivity.
 */
@CapacitorPlugin(name = "LibreBackupStorage")
class LibreBackupStoragePlugin : Plugin() {

    // Which targets are usable right now. Local is always available; Google Drive only if its SAF
    // DocumentsProvider / app is installed — so the web UI only offers Drive when it'll actually work.
    @PluginMethod
    fun detectTargets(call: PluginCall) {
        val res = JSObject()
        res.put("local", true)
        res.put("gdrive", isDriveAvailable())
        call.resolve(res)
    }

    private fun isDriveAvailable(): Boolean {
        val pm = context.packageManager
        // Drive's SAF DocumentsProvider authority is present when the Drive app is installed.
        if (pm.resolveContentProvider("com.google.android.apps.docs.storage", 0) != null) return true
        return try {
            pm.getPackageInfo("com.google.android.apps.docs", 0); true
        } catch (e: Exception) {
            false
        }
    }

    // Launch the system folder picker. Optional `initialUri` hints where to open (Drive root vs local).
    @PluginMethod
    fun pickFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
            )
            call.getString("initialUri")?.let {
                putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(it))
            }
        }
        startActivityForResult(call, intent, "onFolderPicked")
    }

    @ActivityCallback
    private fun onFolderPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val treeUri = result.data?.data
        if (treeUri == null) {
            call.reject("cancelled")
            return
        }
        // Persist so we can write to it later without re-prompting the user.
        context.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        val res = JSObject()
        res.put("treeUri", treeUri.toString())
        call.resolve(res)
    }

    // Rolling single-file backup: overwrite `name` in the chosen tree with the encrypted envelope.
    @PluginMethod
    fun writeFile(call: PluginCall) {
        val treeUri = call.getString("treeUri") ?: return call.reject("missing treeUri")
        val name = call.getString("name") ?: return call.reject("missing name")
        val contents = call.getString("contents") ?: return call.reject("missing contents")
        try {
            val tree = DocumentFile.fromTreeUri(context, Uri.parse(treeUri))
                ?: return call.reject("bad tree uri")
            tree.findFile(name)?.delete()
            val file = tree.createFile("application/json", name) ?: return call.reject("create failed")
            context.contentResolver.openOutputStream(file.uri, "wt").use { out ->
                out?.write(contents.toByteArray(Charsets.UTF_8)) ?: return call.reject("no output stream")
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject("write failed: ${e.message}")
        }
    }

    @PluginMethod
    fun readFile(call: PluginCall) {
        val treeUri = call.getString("treeUri") ?: return call.reject("missing treeUri")
        val name = call.getString("name") ?: return call.reject("missing name")
        try {
            val tree = DocumentFile.fromTreeUri(context, Uri.parse(treeUri))
                ?: return call.reject("bad tree uri")
            val file = tree.findFile(name) ?: return call.reject("not found")
            val text = context.contentResolver.openInputStream(file.uri)
                ?.bufferedReader()?.use { it.readText() }
            val res = JSObject()
            res.put("contents", text ?: "")
            call.resolve(res)
        } catch (e: Exception) {
            call.reject("read failed: ${e.message}")
        }
    }

    // For restore/network detection: which libre-wallet backup files exist in the chosen tree.
    @PluginMethod
    fun listBackups(call: PluginCall) {
        val treeUri = call.getString("treeUri") ?: return call.reject("missing treeUri")
        try {
            val tree = DocumentFile.fromTreeUri(context, Uri.parse(treeUri))
            val names = tree?.listFiles()
                ?.mapNotNull { it.name }
                ?.filter { it.startsWith("libre-wallet-backup") }
                ?: emptyList()
            val res = JSObject()
            res.put("files", JSArray(names))
            call.resolve(res)
        } catch (e: Exception) {
            call.reject("list failed: ${e.message}")
        }
    }
}
