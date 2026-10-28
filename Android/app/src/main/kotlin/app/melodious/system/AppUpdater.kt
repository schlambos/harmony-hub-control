package app.melodious.system

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.provider.Settings
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import java.io.File
import java.security.MessageDigest

/**
 * Installs a downloaded Melodious APK over this app with a PackageInstaller session.
 *
 * Android only accepts an update signed with the installed app's key; [check] refuses earlier, before
 * Android asks anything. On Android 12+ with "Install unknown apps" allowed for Melodious, the update
 * installs without a system dialog (the app updating itself); otherwise Android shows its own
 * "Do you want to update this app?" confirmation.
 */
object AppUpdater {
    /** "Install unknown apps" is allowed for Melodious. */
    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    /** Settings page where the user allows Melodious to install apps. */
    fun unknownSourcesIntent(context: Context): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Why [apk] must not be installed, or null when it's a newer Melodious signed with this app's key. */
    fun check(context: Context, apk: File): String? {
        val pm = context.packageManager
        // Android 9 and 10 fill signing info for archives only when GET_SIGNATURES is also set.
        @Suppress("DEPRECATION")
        val flags = PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(apk.path, flags)
            ?: return "The download isn't an app Android can read."
        if (archive.packageName != context.packageName) return "The download isn't Melodious."
        val installed = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        if (archive.versionCodeCompat() <= installed.versionCodeCompat()) return "The download isn't newer than this app."
        val archiveCerts = certDigests(archive)
        if (archiveCerts.isEmpty() || archiveCerts != certDigests(installed)) {
            return "The download isn't signed with Melodious's key, so it wasn't installed."
        }
        return null
    }

    /** Hands [apk] to Android. The outcome arrives on [events]. */
    fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val callback = Intent(context, AppUpdateReceiver::class.java).setPackage(context.packageName)
            val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, id, callback, piFlags).intentSender)
        }
    }

    sealed interface Event {
        data object Installed : Event
        data class Failed(val message: String) : Event
    }

    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 4)
    val events: SharedFlow<Event> = _events.asSharedFlow()

    internal fun emit(event: Event) {
        _events.tryEmit(event)
    }

    @Suppress("DEPRECATION")
    private fun PackageInfo.versionCodeCompat(): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun certDigests(info: PackageInfo): Set<String> {
        val signatures: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners ?: info.signatures
        } else {
            info.signatures
        }
        return signatures.orEmpty().map { sig ->
            MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }
}

/** PackageInstaller's answer for an update session. */
class AppUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } else {
                    AppUpdater.emit(AppUpdater.Event.Failed("Android didn't say how to finish the update."))
                }
            }
            PackageInstaller.STATUS_SUCCESS -> AppUpdater.emit(AppUpdater.Event.Installed)
            PackageInstaller.STATUS_FAILURE_ABORTED -> AppUpdater.emit(AppUpdater.Event.Failed("The update was cancelled."))
            PackageInstaller.STATUS_FAILURE_CONFLICT ->
                AppUpdater.emit(AppUpdater.Event.Failed("Android refused the update: it isn't signed like the installed app."))
            PackageInstaller.STATUS_FAILURE_BLOCKED ->
                AppUpdater.emit(AppUpdater.Event.Failed("Android blocked the update. $message".trim()))
            else -> AppUpdater.emit(AppUpdater.Event.Failed("The update didn't install. $message".trim()))
        }
    }
}
