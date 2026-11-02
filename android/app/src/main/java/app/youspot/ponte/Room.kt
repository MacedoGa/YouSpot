package app.youspot.ponte

import org.json.JSONObject
import java.text.Normalizer

data class Track(
    val id: String,
    val title: String,
    val artist: String,
    val youtubeId: String?,
    val durationMs: Long,
) {
    val key get() = "$id:$youtubeId"
}

// Espelho do estado da sala enviado pelo servidor (evento "state").
data class RoomState(
    val code: String,
    val queue: List<Track>,
    val index: Int,
    val playing: Boolean,
    val positionMs: Double,
    val updatedAt: Long,
) {
    val current: Track? get() = queue.getOrNull(index)

    // Posição esperada no relógio do servidor.
    fun expectedMs(serverNow: Long): Long =
        if (playing) (positionMs + (serverNow - updatedAt)).toLong() else positionMs.toLong()

    companion object {
        fun parse(o: JSONObject): RoomState {
            val q = o.optJSONArray("queue")
            val tracks = mutableListOf<Track>()
            if (q != null) for (i in 0 until q.length()) {
                val t = q.getJSONObject(i)
                tracks.add(
                    Track(
                        id = t.optString("id"),
                        title = t.optString("title"),
                        artist = t.optString("artist"),
                        // optString devolve "null" para null no JSON
                        youtubeId = if (t.isNull("youtubeId")) null else t.optString("youtubeId").ifBlank { null },
                        durationMs = t.optLong("durationMs", 0),
                    )
                )
            }
            return RoomState(
                code = o.optString("code"),
                queue = tracks,
                index = o.optInt("index", -1),
                playing = o.optBoolean("playing", false),
                positionMs = o.optDouble("positionMs", 0.0),
                updatedAt = o.optLong("updatedAt", 0),
            )
        }
    }
}

fun normalize(s: String?): String =
    Normalizer.normalize(s ?: "", Normalizer.Form.NFD)
        .replace(Regex("\\p{M}+"), "")
        .lowercase()
        .replace(Regex("[^a-z0-9]+"), " ")
        .trim()
