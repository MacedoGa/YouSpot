// Encontra o equivalente de uma faixa na outra plataforma, com cache em memória
// (cada busca no YouTube custa 100 unidades de cota).

const spotify = require('./spotify');
const youtube = require('./youtube');
const { scoreYoutubeCandidate, scoreSpotifyCandidate, pickBest, rankCandidates, normalize } = require('./matching');

const youtubeCache = new Map();
const spotifyCache = new Map();
const CACHE_MAX = 2000;

function remember(cache, key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

// Vídeos que um player já recusou (gravadora bloqueou fora do youtube.com, removido…).
const blockedVideos = new Set();

function blockVideo(id) {
  if (!id) return;
  blockedVideos.add(id);
  for (const [k, v] of youtubeCache) if (v === id) youtubeCache.delete(k);
}

async function findOnYoutube(track, { exclude = [] } = {}) {
  if (!youtube.isConfigured()) return null;
  const key = track.isrc || normalize(`${track.artist || ''} ${track.title || ''}`);
  const skip = new Set([...exclude, ...blockedVideos]);
  if (youtubeCache.has(key) && !skip.has(youtubeCache.get(key))) return youtubeCache.get(key);

  const primaryArtist = (track.artist || '').split(',')[0].trim();
  const candidates = await youtube.search(`${primaryArtist} ${track.title || ''}`.trim(), 8);
  const ranked = rankCandidates(
    track,
    candidates.filter((c) => !skip.has(c.youtubeId)).map((c) => ({ ...c, title: c.rawTitle })),
    scoreYoutubeCandidate
  );
  // Confere os melhores: o primeiro que pode tocar embutido na página ganha.
  let id = null;
  for (const c of ranked.slice(0, 4)) {
    if (await youtube.isEmbeddable(c.youtubeId)) {
      id = c.youtubeId;
      break;
    }
    blockedVideos.add(c.youtubeId);
  }
  remember(youtubeCache, key, id);
  return id;
}

// tokenProvider: async () => token de acesso para a busca (ver spotify.searchToken).
async function findOnSpotify(track, { tokenProvider } = {}) {
  if (!spotify.isConfigured()) return null;
  const key = normalize(`${track.artist || ''} ${track.title || ''}`);
  if (spotifyCache.has(key)) return spotifyCache.get(key);

  // Obtém o token uma vez (erro "Conecte o Spotify…" sobe para matchErrors e não entra no cache).
  const token = tokenProvider ? await tokenProvider() : await spotify.searchToken([]);
  let candidates = [];
  if (track.artist) {
    candidates = await spotify.search(`track:${track.title} artist:${track.artist}`, { limit: 5, token });
  }
  if (!candidates.length) candidates = await spotify.search(`${track.artist || ''} ${track.title || ''}`.trim(), { limit: 5, token });

  const best = pickBest(track, candidates, scoreSpotifyCandidate);
  remember(spotifyCache, key, best || null);
  return best || null;
}

// Completa a faixa com o ID que estiver faltando. Erros não impedem a faixa de entrar na fila.
async function completeTrack(track, { tokenProvider } = {}) {
  const out = { ...track, isrc: track.isrc || null, matchErrors: [] };
  try {
    if (!out.youtubeId && out.spotifyUri) out.youtubeId = await findOnYoutube(out);
  } catch (err) {
    out.matchErrors.push(err.message);
  }
  try {
    if (!out.spotifyUri && out.youtubeId) {
      const sp = await findOnSpotify(out, { tokenProvider });
      if (sp) {
        // Metadados do Spotify são mais limpos; mantém a duração do vídeo que já está tocando
        // (usa a do Spotify só se o vídeo não informou duração).
        Object.assign(out, {
          spotifyUri: sp.spotifyUri,
          spotifyAlbumUri: sp.spotifyAlbumUri || null,
          title: sp.title,
          artist: sp.artist,
          isrc: sp.isrc || out.isrc || null,
          art: out.art || sp.art,
          durationMs: out.durationMs || sp.durationMs || 0,
        });
      }
    }
  } catch (err) {
    out.matchErrors.push(err.message);
  }
  return out;
}

module.exports = { completeTrack, findOnYoutube, findOnSpotify, blockVideo };
