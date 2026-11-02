package app.youspot.ponte

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

object Prefs {
    private fun sp(c: Context) = c.getSharedPreferences("ponte", Context.MODE_PRIVATE)

    // Identidade deste aparelho na sala (o servidor aceita UUID minúsculo).
    fun sid(c: Context): String {
        val p = sp(c)
        return p.getString("sid", null) ?: UUID.randomUUID().toString().also { p.edit().putString("sid", it).apply() }
    }

    fun server(c: Context) = sp(c).getString("server", "") ?: ""
    fun room(c: Context) = sp(c).getString("room", "") ?: ""
    fun name(c: Context) = sp(c).getString("name", "") ?: ""

    fun save(c: Context, server: String, room: String, name: String) {
        sp(c).edit().putString("server", server).putString("room", room).putString("name", name).apply()
    }
}

// Status do serviço para a tela (o serviço e a tela rodam no mesmo processo).
object Bridge {
    @Volatile var status: String = "Fora da jam"
        private set
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    fun set(s: String) {
        if (s == status) return
        status = s
        main.post { listeners.forEach { it() } }
    }

    fun listen(l: () -> Unit) = listeners.add(l)
    fun unlisten(l: () -> Unit) = listeners.remove(l)
}
