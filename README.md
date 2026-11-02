# Jam Sync

Uma "Jam" estilo Spotify em que **cada pessoa ouve pela plataforma que quiser**: Spotify ou YouTube Music. A fila é compartilhada, e todos ouvem a mesma música no mesmo ponto.

É um **PWA**: abre no navegador do celular (Android ou iOS) e pode ser instalado na tela inicial.

## Como funciona

```
            ┌───────────── servidor (Node + Socket.IO) ─────────────┐
            │  sala: fila, faixa atual, posição, tocando/pausado     │
            │  relógio do servidor = fonte da verdade               │
            └──────┬───────────────────────────┬────────────────────┘
                   │ Web API (Spotify Connect)  │ WebSocket: estado + hora
                   ▼                            ▼
       app do Spotify no celular        PWA com player do YouTube
       (toca com a tela bloqueada)      (corrige atraso a cada 1s)
```

- **Fila neutra:** cada faixa guarda título, artista, duração, ISRC, `spotifyUri` e `youtubeId`. Quando alguém adiciona uma música, o servidor procura o equivalente na outra plataforma (`server/resolver.js`) e dá nota aos candidatos por título, artista, duração e canal "- Topic". Versões ao vivo, covers e remixes perdem pontos.
- **Spotify:** o **servidor** manda o app do Spotify de cada pessoa tocar a faixa na posição certa. A cada 8s ele confere se alguém saiu de sincronia (mais de 2,5s) e corrige. Como quem manda é o servidor, a pessoa pode bloquear a tela.
- **YouTube:** o PWA sincroniza o relógio com o servidor e usa o player oficial embutido (IFrame API). Se o atraso passa de 0,8s, ele pula para a posição certa.

## Limitações (importante)

| | |
|---|---|
| **Spotify Premium** | Controlar a reprodução pela API exige Premium, e em development mode toda conta cadastrada precisa ser Premium. |
| **App Spotify em "development mode"** | Só usuários cadastrados no dashboard do app podem conectar (User Management, até 5 contas). Serve para amigos; para abrir ao público é preciso pedir aprovação ao Spotify. |
| **YouTube em segundo plano** | O player embutido para quando a tela apaga ou o app vai pro fundo. O app pede para a tela ficar ligada (Wake Lock), mas quem ouve pelo YouTube precisa manter o app aberto. |
| **Cota do YouTube** | Só com `YOUTUBE_API_KEY`: 10.000 unidades/dia. Cada busca custa 100, então dá umas 100 buscas por dia, somando as buscas manuais e a conversão de cada faixa do Spotify. Colar um link custa 1. |
| **iOS + YouTube** | Na primeira música, o Safari pode exigir um toque no vídeo para liberar o som. |
| **Correspondência** | Às vezes o vídeo encontrado é a versão errada. Use o botão 🔗 na fila para colar o link certo. |

## Configuração

### 1. Spotify (uma vez, pelo dono do servidor)
O login usa **Authorization Code + PKCE**: só existe **um Client ID**, criado uma vez por quem roda o servidor. **Ninguém cola Client Secret** — nem você, nem os amigos. Cada amigo só toca em **Entrar com Spotify**.

1. Acesse <https://developer.spotify.com/dashboard> → **Create app**, marque **Web API**.
2. Em **Redirect URIs**, adicione `<BASE_URL>/auth/spotify/callback`. Exemplos:
   - local: `http://127.0.0.1:3000/auth/spotify/callback` (o Spotify não aceita `localhost`, só `127.0.0.1`)
   - celular via túnel: `https://seu-tunel.trycloudflare.com/auth/spotify/callback`
3. Em **User Management**, cadastre nome e e-mail da conta Spotify de cada amigo. Regra do Spotify (2026) para apps em *development mode*: **no máximo 5 contas**, e todas precisam ser **Premium** (inclusive a sua).
4. Copie só o **Client ID** (32 caracteres) e escolha um jeito de informar ao servidor:
   - abra `http://127.0.0.1:3000` **no próprio computador do servidor** e cole o Client ID na tela de configuração (fica salvo em `data/config.json`); essa tela só aparece para quem acessa pelo próprio computador e só enquanto nada foi configurado; ou
   - coloque `SPOTIFY_CLIENT_ID=...` no `.env`.

`SPOTIFY_CLIENT_SECRET` é opcional e serve só como reserva para a **busca** no catálogo quando ninguém da sala entrou com o Spotify. Sem ele, a busca usa o login de quem está na sala; se ninguém entrou, o app pede para conectar o Spotify.

**Cada amigo:** abre o link da sala → **Entrar com Spotify** → autoriza. Pronto. Se o Spotify recusar, confira se a conta dele está em User Management e se é Premium.

### 2. YouTube (opcional)
**Não precisa configurar nada.** Sem chave, o servidor usa a mesma busca interna do site do YouTube: sem cota e sem cadastro. Ela não é oficial, então pode parar de funcionar se o YouTube mudar o site. Se isso acontecer, o terminal mostra linhas `[youtube]`.

Para usar a API oficial (estável, mas com cota de ~100 buscas por dia):
1. Acesse <https://console.cloud.google.com> → crie um projeto → **Enable APIs** → **YouTube Data API v3**.
2. Em **Credentials**, clique em **Create credentials → API key**. Se quiser, restrinja a chave à YouTube Data API.

### 3. Rodar
```bash
cp .env.example .env   # opcional: YOUTUBE_API_KEY, BASE_URL (o Client ID pode ser colado na tela)
npm install
npm start
```

### 4. Usar no celular
Os celulares precisam acessar o servidor por **HTTPS**, porque o Spotify e a instalação do PWA exigem isso. O jeito mais fácil é um túnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Coloque a URL `https://…trycloudflare.com` gerada em `BASE_URL` no `.env`, cadastre o Redirect URI correspondente no Spotify e reinicie o servidor. A tela de configuração do Client ID nunca aparece para quem acessa pelo túnel; faça a configuração em `http://127.0.0.1:3000` ou pelo `.env`. Atenção: essa URL muda toda vez que você roda o comando. Para uso frequente, publique num serviço como Render ou Railway, ou use um túnel com nome fixo.

No celular: abra o link → *Adicionar à tela inicial* → crie a jam → toque no código da sala para compartilhar.

**Quem ouve pelo Spotify:** abra o app do Spotify e toque qualquer música uma vez, para o aparelho aparecer como dispositivo ativo. Depois, no Jam Sync, toque em **Entrar com Spotify** e autorize. Você volta para a mesma sala, no mesmo lugar (e o anfitrião continua anfitrião).

**O app do Spotify também controla a sala:** pausar, tocar, pular para um ponto, próxima/anterior ou escolher outra música no app do Spotify vale para todo mundo (a sala percebe em até ~3s). "Próxima/anterior" andam pela fila do YouSpot, não pelo álbum.

### 5. Ouvir pelo app do YouTube Music (Android, Premium)
O YouTube Music não tem API para ser controlado de fora. O **YouSpot Ponte** (pasta `android/`) é um app Android que fica conectado à jam e controla o app oficial do YouTube Music pelo controle de mídia do Android (o mesmo da notificação e do fone Bluetooth). Funciona com a tela bloqueada.

1. No celular, baixe e instale: <https://github.com/MacedoGa/YouSpot/releases/latest/download/youspot-ponte.apk> (o Android pede para permitir "instalar apps desconhecidos" do navegador).
2. Abra o YouSpot Ponte e libere o que ele pede: **acesso às notificações**, **sobrepor outros apps**, notificações e (recomendado) **sem restrição de bateria**. No Android 13+ o acesso às notificações de apps instalados por APK vem bloqueado: Configurações › Apps › YouSpot Ponte › ⋮ › *Permitir configurações restritas*.
3. No site da jam, toque em **▶ Ouvir pelo app do YouTube Music**: o app ponte abre já na sala certa.

Limitações: só Android; precisa do YouTube Music **Premium** (sem ele o YouTube Music para em segundo plano); a integração não é oficial, então uma atualização do YouTube Music pode mudar o comportamento. O APK é compilado pelo GitHub Actions (`.github/workflows/android.yml`) a cada mudança em `android/`.

## Estrutura

```
server/
  index.js      HTTP, OAuth do Spotify e eventos Socket.IO
  rooms.js      estado da sala, relógio, troca de faixa, sincronia do Spotify
  spotify.js    Web API (busca + controle do player) e tokens dos usuários
  youtube.js    YouTube Data API v3
  resolver.js   encontra a faixa equivalente na outra plataforma (com cache)
  matching.js   funções puras de comparação (testadas)
public/         PWA (HTML/CSS/JS puro, service worker, manifest)
test/           node --test
```

O Client ID colado na tela fica em `data/config.json` e os tokens do Spotify em `data/spotify-tokens.json`, fora do git (a pasta pode ser trocada com `DATA_DIR`). As salas ficam só na memória: se o servidor reiniciar, elas somem.

```bash
npm test
```
