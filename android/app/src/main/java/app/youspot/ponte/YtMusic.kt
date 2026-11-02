package app.youspot.ponte

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings

// Controle do app oficial do YouTube Music pelo controle de mídia do Android
// (o mesmo que a notificação e o fone Bluetooth usam).
object YtMusic {
    const val PKG = "com.google.android.apps.youtube.music"

    fun isInstalled(c: Context): Boolean = try {
        c.packageManager.getPackageInfo(PKG, 0)
        true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    // Sem "acesso às notificações" o Android não deixa ver os players de outros apps.
    fun hasListenerAccess(c: Context): Boolean {
        val flat = Settings.Secure.getString(c.contentResolver, "enabled_notification_listeners") ?: return false
        return flat.contains(c.packageName)
    }

    fun controller(c: Context): MediaController? = try {
        val msm = c.getSystemService(MediaSessionManager::class.java)
        msm.getActiveSessions(ComponentName(c, MediaListener::class.java)).firstOrNull { it.packageName == PKG }
    } catch (e: SecurityException) {
        null
    }

    fun positionMs(mc: MediaController): Long {
        val s = mc.playbackState ?: return 0
        var p = s.position
        if (s.state == PlaybackState.STATE_PLAYING && s.lastPositionUpdateTime > 0) {
            p += ((SystemClock.elapsedRealtime() - s.lastPositionUpdateTime) * s.playbackSpeed).toLong()
        }
        return p
    }

    fun isPlaying(mc: MediaController) = mc.playbackState?.state == PlaybackState.STATE_PLAYING

    fun isBuffering(mc: MediaController): Boolean {
        val st = mc.playbackState?.state
        return st == PlaybackState.STATE_BUFFERING || st == PlaybackState.STATE_CONNECTING
    }

    fun durationMs(mc: MediaController): Long = mc.metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0

    fun title(mc: MediaController): String = mc.metadata?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: ""

    // O YouTube Music está com a faixa da sala carregada?
    fun matches(mc: MediaController, t: Track): Boolean {
        val md = mc.metadata ?: return false
        val id = md.getString(MediaMetadata.METADATA_KEY_MEDIA_ID)
        if (id != null && t.youtubeId != null && id.contains(t.youtubeId)) return true
        val a = normalize(md.getString(MediaMetadata.METADATA_KEY_TITLE))
        val b = normalize(t.title)
        if (a.isEmpty() || b.isEmpty()) return false
        return a == b || a.contains(b) || b.contains(a)
    }

    fun watchUri(videoId: String): Uri = Uri.parse("https://music.youtube.com/watch?v=$videoId")

    fun supportsPlayFromUri(mc: MediaController?): Boolean =
        mc != null && ((mc.playbackState?.actions ?: 0L) and PlaybackState.ACTION_PLAY_FROM_URI) != 0L

    // Abre a música no app (funciona com o app ponte em segundo plano se tiver "sobrepor outros apps").
    fun openInApp(c: Context, videoId: String) {
        c.startActivity(
            Intent(Intent.ACTION_VIEW, watchUri(videoId))
                .setPackage(PKG)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
