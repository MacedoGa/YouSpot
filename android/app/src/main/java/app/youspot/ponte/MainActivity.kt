package app.youspot.ponte

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

// Tela única: dados da sala, permissões (com o passo a passo) e entrar/sair.
class MainActivity : Activity() {

    private val bg = Color.parseColor("#0F0F14")
    private val surface = Color.parseColor("#191921")
    private val cText = Color.parseColor("#F2F2F5")
    private val muted = Color.parseColor("#9A9AAB")
    private val ok = Color.parseColor("#1ED760")
    private val warn = Color.parseColor("#FFB648")
    private val accent = Color.parseColor("#8B5CF6")

    private lateinit var serverIn: EditText
    private lateinit var roomIn: EditText
    private lateinit var nameIn: EditText
    private lateinit var statusTv: TextView
    private lateinit var permsBox: LinearLayout
    private lateinit var joinBtn: Button
    private lateinit var leaveBtn: Button

    private val onStatus: () -> Unit = { renderStatus() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = bg
        val pad = dp(16)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dp(28), pad, dp(32))
        }
        col.addView(label("YouSpot Ponte", 26f, cText, bold = true))
        col.addView(label("Toca a jam no app do YouTube Music, sincronizado, com a tela bloqueada.", 14f, muted))

        col.addView(section("Sala"))
        serverIn = input("Servidor (ex.: https://youspot-1.onrender.com)", InputType.TYPE_TEXT_VARIATION_URI)
        roomIn = input("Código da sala ou link da jam", InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        nameIn = input("Seu nome", InputType.TYPE_TEXT_VARIATION_PERSON_NAME)
        col.addView(serverIn)
        col.addView(roomIn)
        col.addView(nameIn)

        col.addView(section("Permissões (uma vez só)"))
        permsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(permsBox)

        col.addView(section("Status"))
        statusTv = label("", 15f, cText)
        col.addView(statusTv)

        joinBtn = button("Entrar na jam", accent) { join() }
        leaveBtn = button("Sair da jam", surface) { JamService.stop(this) }
        col.addView(joinBtn)
        col.addView(leaveBtn)

        setContentView(ScrollView(this).apply {
            setBackgroundColor(bg)
            addView(col)
        })

        serverIn.setText(Prefs.server(this))
        roomIn.setText(Prefs.room(this))
        nameIn.setText(Prefs.name(this))
        handleLink(intent)
        Bridge.listen(onStatus)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        renderPerms()
        renderStatus()
    }

    override fun onDestroy() {
        Bridge.unlisten(onStatus)
        super.onDestroy()
    }

    // Botão do site: youspot://join?server=…&room=…&name=…
    private fun handleLink(i: Intent?) {
        val data = i?.data ?: return
        if (data.scheme != "youspot") return
        data.getQueryParameter("server")?.let { serverIn.setText(it) }
        data.getQueryParameter("room")?.let { roomIn.setText(it) }
        data.getQueryParameter("name")?.takeIf { it.isNotBlank() }?.let { nameIn.setText(it) }
        if (missingPerms().isEmpty()) join()
    }

    private fun join() {
        var server = serverIn.text.toString().trim().trimEnd('/')
        var room = roomIn.text.toString().trim()
        // Aceita o link inteiro da jam (https://…/?room=ABCD).
        if (room.contains("room=")) {
            val u = Uri.parse(room)
            u.getQueryParameter("room")?.let { room = it }
            if (server.isEmpty() && u.scheme != null && u.host != null) {
                server = "${u.scheme}://${u.host}${if (u.port > 0) ":${u.port}" else ""}"
            }
        }
        room = room.uppercase()
        if (!server.startsWith("http")) return toast("Coloque o endereço do servidor (começa com https://)")
        if (room.length < 4) return toast("Coloque o código da sala")
        val missing = missingPerms()
        if (missing.isNotEmpty()) return toast("Falta: ${missing.first()}")
        Prefs.save(this, server, room, nameIn.text.toString().trim())
        if (JamService.running) JamService.stop(this)
        window.decorView.postDelayed({ JamService.start(this) }, if (JamService.running) 400L else 0L)
    }

    // ---------- permissões ----------

    private fun hasPostNotifications() =
        Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun ignoresBattery() = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    private fun missingPerms(): List<String> = buildList {
        if (!YtMusic.isInstalled(this@MainActivity)) add("instalar o YouTube Music")
        if (!YtMusic.hasListenerAccess(this@MainActivity)) add("acesso às notificações")
        if (!Settings.canDrawOverlays(this@MainActivity)) add("sobrepor outros apps")
        if (!hasPostNotifications()) add("permissão de notificações")
    }

    private fun renderPerms() {
        permsBox.removeAllViews()
        permRow(
            YtMusic.isInstalled(this),
            "YouTube Music instalado",
            "Instale e entre com a conta Premium.",
            "Abrir loja",
        ) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=${YtMusic.PKG}")))
        }
        permRow(
            YtMusic.hasListenerAccess(this),
            "Acesso às notificações",
            "Deixa o app controlar o player do YouTube Music. Se a opção aparecer bloqueada (\"configuração restrita\"): " +
                "Configurações > Apps > YouSpot Ponte > ⋮ (canto de cima) > Permitir configurações restritas, e volte aqui.",
            "Liberar",
        ) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        permRow(
            Settings.canDrawOverlays(this),
            "Sobrepor outros apps",
            "Necessário para trocar de música com a tela bloqueada ou o app fechado.",
            "Liberar",
        ) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        permRow(hasPostNotifications(), "Mostrar notificação", "Mostra o status da jam e o botão de sair.", "Permitir") {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        permRow(
            ignoresBattery(),
            "Sem restrição de bateria (recomendado)",
            "Sem isso o Android pode desligar a conexão com a tela bloqueada.",
            "Liberar",
        ) {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        renderPerms()
    }

    private fun permRow(done: Boolean, title: String, hint: String, action: String, onClick: () -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setBackgroundColor(surface)
        }
        row.addView(label((if (done) "✓ " else "• ") + title, 15f, if (done) ok else warn, bold = true))
        if (!done) {
            row.addView(label(hint, 13f, muted))
            row.addView(button(action, accent) {
                try {
                    onClick()
                } catch (e: Exception) {
                    toast("Abra as Configurações do Android e procure por \"$title\"")
                }
            })
        }
        permsBox.addView(row, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
    }

    // ---------- status ----------

    private fun renderStatus() {
        statusTv.text = Bridge.status
        joinBtn.text = if (JamService.running) "Entrar de novo / trocar de sala" else "Entrar na jam"
        leaveBtn.visibility = if (JamService.running) View.VISIBLE else View.GONE
    }

    // ---------- helpers de UI ----------

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun label(s: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun section(s: String) = label(s.uppercase(), 12f, muted, bold = true).apply { setPadding(0, dp(20), 0, dp(6)) }

    private fun input(hint: String, type: Int) = EditText(this).apply {
        this.hint = hint
        inputType = InputType.TYPE_CLASS_TEXT or type
        setTextColor(cText)
        setHintTextColor(muted)
        setBackgroundColor(surface)
        setPadding(dp(12), dp(12), dp(12), dp(12))
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) }
    }

    private fun button(s: String, color: Int, onClick: () -> Unit) = Button(this).apply {
        text = s
        isAllCaps = false
        setTextColor(Color.WHITE)
        setBackgroundColor(color)
        gravity = Gravity.CENTER
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}
