package app.youspot.ponte

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.session.MediaController
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import kotlin.math.abs

// Fica conectado à jam (Socket.IO) e mantém o YouTube Music na mesma faixa e posição da sala,
// do mesmo jeito que o site faz com o player embutido. Roda com a tela bloqueada.
class JamService : Service() {

    companion object {
        private const val ACTION_START = "app.youspot.ponte.START"
        private const val ACTION_STOP = "app.youspot.ponte.STOP"
        private const val CHANNEL = "jam"
        private const val NOTIF_ID = 1

        private const val DRIFT_TOLERANCE_MS = 250L
        private const val SEEK_COOLDOWN_MS = 3000L
        private const val LOAD_TIMEOUT_MS = 9000L
        private const val LEARN_RATE = 0.7

        @Volatile var running = false
            private set

        fun start(c: Context) {
            c.startForegroundService(Intent(c, JamService::class.java).setAction(ACTION_START))
        }

        fun stop(c: Context) {
            c.startService(Intent(c, JamService::class.java).setAction(ACTION_STOP))
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var socket: Socket? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var room: RoomState? = null

    private var clockOffset = 0L
    private var bestRtt = Long.MAX_VALUE

    // Faixa carregada no YouTube Music e como foi carregada.
    private var loadedKey: String? = null
    private var loadAt = 0L
    private var loadMethod = ""
    private var confirmed = false
    private var attemptsKey: String? = null
    private var loadAttempts = 0
    private var usePlayFromUri = true

    // Ajuste fino: compensação do seek calibrada como no servidor (Spotify).
    private var lastCmd = 0L
    private var seekCompMs = 300L
    private var learnPending = false

    private val tick = object : Runnable {
        override fun run() {
            sync()
            main.postDelayed(this, 1000)
        }
    }
    private val clockTick = object : Runnable {
        override fun run() {
            if (socket?.connected() == true) syncClock(3)
            main.postDelayed(this, 30_000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground("Conectando à jam…")
        if (!running) {
            running = true
            acquireWakeLock()
            connect()
            main.post(tick)
            main.postDelayed(clockTick, 30_000)
        }
        // Se o Android matar o serviço, ele volta sozinho com a sala salva.
        return START_STICKY
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    // ---------- conexão ----------

    private fun connect() {
        val server = Prefs.server(this).trimEnd('/')
        val code = Prefs.room(this)
        if (server.isEmpty() || code.isEmpty()) {
            status("Falta o endereço do servidor ou o código da sala")
            return
        }
        val opts = IO.Options().apply {
            auth = mapOf("sid" to Prefs.sid(this@JamService))
            reconnection = true
            forceNew = true
        }
        val s = try {
            IO.socket(server, opts)
        } catch (e: Exception) {
            status("Endereço inválido: $server")
            return
        }
        s.on(Socket.EVENT_CONNECT) { main.post { onConnected() } }
        s.on(Socket.EVENT_DISCONNECT) { main.post { status("Sem conexão com o servidor… tentando de novo") } }
        s.on(Socket.EVENT_CONNECT_ERROR) { args ->
            main.post { status("Não conectou ao servidor (${args.firstOrNull() ?: "erro"}). Tentando de novo…") }
        }
        s.on("state") { args ->
            val o = args.firstOrNull() as? JSONObject ?: return@on
            val st = try {
                RoomState.parse(o)
            } catch (e: Exception) {
                return@on
            }
            main.post {
                room = st
                sync()
            }
        }
        socket = s
        s.connect()
    }

    private fun onConnected() {
        status("Conectado. Entrando na sala…")
        syncClock(5) {
            val name = Prefs.name(this).ifBlank { "YouTube Music" }
            emit("room:join", JSONObject().put("code", Prefs.room(this)).put("name", name)) { r ->
                if (r?.optBoolean("ok") != true) {
                    status("Não entrou na sala: ${r?.optString("error") ?: "sem resposta"}")
                    return@emit
                }
                emit("platform:set", JSONObject().put("platform", "ytmusic"))
            }
        }
    }

    private fun emit(event: String, payload: JSONObject, cb: (JSONObject?) -> Unit = {}) {
        val s = socket ?: return cb(null)
        s.emit(event, arrayOf<Any>(payload), Ack { args ->
            val r = args.firstOrNull() as? JSONObject
            main.post { cb(r) }
        })
    }

    // Mesmo algoritmo do site: guarda a amostra com menor ida e volta.
    private fun syncClock(samples: Int, done: () -> Unit = {}) {
        bestRtt = Long.MAX_VALUE
        fun one(left: Int) {
            val s = socket
            if (left == 0 || s == null) return done()
            val t0 = System.currentTimeMillis()
            s.emit("time", arrayOf<Any>(t0), Ack { args ->
                val t1 = System.currentTimeMillis()
                val serverTime = (args.firstOrNull() as? Number)?.toLong()
                main.post {
                    if (serverTime != null) {
                        val rtt = t1 - t0
                        if (rtt < bestRtt) {
                            bestRtt = rtt
                            clockOffset = serverTime - (t0 + rtt / 2)
                        }
                    }
                    one(left - 1)
                }
            })
        }
        one(samples)
    }

    private fun serverNow() = System.currentTimeMillis() + clockOffset

    // ---------- sincronia com o YouTube Music ----------

    private fun sync() {
        val st = room ?: return
        if (!YtMusic.hasListenerAccess(this)) {
            status("Falta liberar o \"acesso às notificações\" (abra o YouSpot Ponte)")
            return
        }
        val mc = YtMusic.controller(this)
        val t = st.current
        if (t == null) {
            pauseIfPlaying(mc)
            loadedKey = null
            status("Fila vazia: adicione músicas pelo site")
            return
        }
        if (t.youtubeId == null) {
            pauseIfPlaying(mc)
            loadedKey = null
            status("\"${t.title}\" não tem versão no YouTube. Esperando a próxima…")
            return
        }
        val exp = st.expectedMs(serverNow())
        val now = SystemClock.elapsedRealtime()
        if (attemptsKey != t.key) {
            attemptsKey = t.key
            loadAttempts = 0
        }

        if (loadedKey != t.key) {
            if (!st.playing) {
                pauseIfPlaying(mc)
                status("Pausado: ${t.title}")
                return
            }
            if (t.durationMs > 0 && exp >= t.durationMs - 1500) return // a sala já vai trocar de faixa
            load(mc, t)
            return
        }

        if (!confirmed) {
            if (mc != null && YtMusic.matches(mc, t)) {
                confirmed = true
                loadAttempts = 0
                lastCmd = 0
                learnPending = false
            } else {
                if (now - loadAt > LOAD_TIMEOUT_MS) {
                    // Não carregou: troca de método (playFromUri -> abrir o link) e tenta de novo.
                    if (loadMethod == "uri") usePlayFromUri = false
                    loadAttempts++
                    loadedKey = null
                    if (loadAttempts >= 2) {
                        status("O YouTube Music não abriu \"${t.title}\". Desbloqueie a tela ou deixe o YouTube Music aberto.")
                    }
                }
                return
            }
        }

        if (mc == null) {
            loadedKey = null // o YouTube Music foi fechado: abre de novo
            return
        }
        if (!YtMusic.matches(mc, t)) {
            // O YouTube Music foi para outra música (autoplay dele ou alguém mexeu): volta para a da sala.
            if (st.playing) loadedKey = null else pauseIfPlaying(mc)
            return
        }

        val c = mc.transportControls
        val pos = YtMusic.positionMs(mc)
        val ytDur = YtMusic.durationMs(mc)
        if (st.playing) {
            // Vídeo acabando antes da sala trocar: pausa para o YouTube Music não emendar outra música.
            if (ytDur > 0 && pos >= ytDur - 1200) {
                pauseIfPlaying(mc)
                return
            }
            if (!YtMusic.isPlaying(mc)) {
                if (!YtMusic.isBuffering(mc) && now - lastCmd > 1500) {
                    c.seekTo(exp + seekCompMs)
                    c.play()
                    lastCmd = now
                    learnPending = true
                }
                status("Começando: ${t.title}")
                return
            }
            val drift = pos - exp
            if (learnPending && now - lastCmd > 2500) {
                seekCompMs = (seekCompMs - (drift * LEARN_RATE).toLong()).coerceIn(0L, 2000L)
                learnPending = false
            }
            if (abs(drift) > DRIFT_TOLERANCE_MS && now - lastCmd > SEEK_COOLDOWN_MS) {
                c.seekTo(exp + seekCompMs)
                lastCmd = now
                learnPending = true
            }
            status("Tocando: ${t.title} (diferença ${drift} ms)")
        } else {
            if (YtMusic.isPlaying(mc)) {
                c.pause()
                lastCmd = now
            } else if (abs(pos - exp) > 1000 && now - lastCmd > 1500) {
                c.seekTo(exp)
                lastCmd = now
            }
            status("Pausado: ${t.title}")
        }
    }

    private fun load(mc: MediaController?, t: Track) {
        val id = t.youtubeId ?: return
        loadedKey = t.key
        loadAt = SystemClock.elapsedRealtime()
        confirmed = false
        // 1º: comando direto pelo controle de mídia (não precisa abrir a tela). 2º: abrir o link no app.
        if (usePlayFromUri && YtMusic.supportsPlayFromUri(mc)) {
            mc!!.transportControls.playFromUri(YtMusic.watchUri(id), Bundle())
            loadMethod = "uri"
            status("Abrindo \"${t.title}\" no YouTube Music…")
            return
        }
        try {
            YtMusic.openInApp(this, id)
            loadMethod = "intent"
            status("Abrindo \"${t.title}\" no YouTube Music (link)…")
        } catch (e: ActivityNotFoundException) {
            status("O YouTube Music não está instalado neste celular")
        } catch (e: Exception) {
            status("Não consegui abrir o YouTube Music: ${e.message}")
        }
    }

    private fun pauseIfPlaying(mc: MediaController?) {
        if (mc != null && YtMusic.isPlaying(mc)) mc.transportControls.pause()
    }

    // ---------- serviço em primeiro plano ----------

    private var lastNotified = ""

    private fun status(s: String) {
        Bridge.set(s)
        if (s != lastNotified && running) {
            lastNotified = s
            getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notification(s))
        }
    }

    private fun notification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Jam", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, JamService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("YouSpot: sala ${Prefs.room(this)}")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null as Icon?, "Sair da jam", stop).build())
            .build()
    }

    private fun startInForeground(text: String) {
        val n = notification(text)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
        Bridge.set(text)
    }

    // Sem isso o Android para a conexão com a tela bloqueada.
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "YouSpot:jam")
            .apply { acquire() }
    }

    private fun shutdown() {
        if (!running) return
        running = false
        main.removeCallbacks(tick)
        main.removeCallbacks(clockTick)
        socket?.off()
        socket?.disconnect()
        socket = null
        room = null
        loadedKey = null
        pauseIfPlaying(YtMusic.controller(this))
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        Bridge.set("Fora da jam")
    }
}
