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
| **Spotify Premium** | Controlar a reprodução pela API exige Premium. |
| **App Spotify em "development mode"** | Só usuários cadastrados no dashboard do app podem conectar (User Management). Serve para amigos; para abrir ao público é preciso pedir aprovação ao Spotify. |
| **YouTube em segundo plano** | O player embutido para quando a tela apaga ou o app vai pro fundo. O app pede para a tela ficar ligada (Wake Lock), mas quem ouve pelo YouTube precisa manter o app aberto. |
| **Cota do YouTube** | 10.000 unidades/dia. Cada busca custa 100, então dá umas 100 buscas por dia, somando as buscas manuais e a conversão de cada faixa do Spotify. Colar um link custa 1. |
| **iOS + YouTube** | Na primeira música, o Safari pode exigir um toque no vídeo para liberar o som. |
| **Correspondência** | Às vezes o vídeo encontrado é a versão errada. Use o botão 🔗 na fila para colar o link certo. |

## Configuração

### 1. Spotify
1. Acesse <https://developer.spotify.com/dashboard> → **Create app**, marque **Web API**.
2. Em **Redirect URIs**, adicione `<BASE_URL>/auth/spotify/callback`. Exemplos:
   - local: `http://127.0.0.1:3000/auth/spotify/callback` (o Spotify não aceita `localhost`, só `127.0.0.1`)
   - celular via túnel: `https://seu-tunel.trycloudflare.com/auth/spotify/callback`
3. Em **User Management**, cadastre o e-mail do Spotify de cada amigo.
4. Copie o Client ID e o Client Secret.

### 2. YouTube
1. Acesse <https://console.cloud.google.com> → crie um projeto → **Enable APIs** → **YouTube Data API v3**.
2. Em **Credentials**, clique em **Create credentials → API key**. Se quiser, restrinja a chave à YouTube Data API.

### 3. Rodar
```bash
cp .env.example .env   # preencha as chaves
npm install
npm start
```

### 4. Usar no celular
Os celulares precisam acessar o servidor por **HTTPS**, porque o Spotify e a instalação do PWA exigem isso. O jeito mais fácil é um túnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Coloque a URL `https://…trycloudflare.com` gerada em `BASE_URL` no `.env`, cadastre o Redirect URI correspondente no Spotify e reinicie o servidor. Atenção: essa URL muda toda vez que você roda o comando. Para uso frequente, publique num serviço como Render ou Railway, ou use um túnel com nome fixo.

No celular: abra o link → *Adicionar à tela inicial* → crie a jam → toque no código da sala para compartilhar.

**Quem ouve pelo Spotify:** abra o app do Spotify e toque qualquer música uma vez, para o aparelho aparecer como dispositivo ativo. Depois, no Jam Sync, escolha **Spotify** e autorize.

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

Os tokens do Spotify ficam em `data/spotify-tokens.json`, fora do git. As salas ficam só na memória: se o servidor reiniciar, elas somem.

```bash
npm test
```
