package app.youspot.ponte

import android.service.notification.NotificationListenerService

// Vazio de propósito: com ele ativo em "Acesso às notificações", o Android libera
// o MediaSessionManager.getActiveSessions, que dá o controle do YouTube Music.
class MediaListener : NotificationListenerService()
