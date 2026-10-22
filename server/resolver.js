// Encontra o equivalente de uma faixa na outra plataforma, com cache em memória
// (cada busca no YouTube custa 100 unidades de cota).

const spotify = require('./spotify');
const youtube = require('./youtube');
const { scoreYoutubeCandidate, scoreSpotifyCandidate, pickBest, normalize } = require('./matching');

const youtubeCache = new Map();
const spotifyCache = new Map();

async function findOnYoutube(track) {
  if (!youtube.isConfigured()) return null;
  const key = track.isrc || normalize(`${track.artist} ${track.title}`);
  if (youtubeCache.has(key)) return youtubeCache.get(key);

  const primaryArtist = track.artist.split(',')[0];
  const candidates = await youtube.search(`${primaryArtist} ${track.title}`, 6);
  const best = pickBest(
    track,
    candidates.map((c) => ({ ...c, title: c.rawTitle })),
    scoreYoutubeCandidate
  );
  const id = best?.youtubeId || null;
  youtubeCache.set(key, id);
  return id;
}

async function findOnSpotify(track) {
  if (!spotify.isConfigured()) return null;
  const key = normalize(`${track.artist} ${track.title}`);
  if (spotifyCache.has(key)) return spotifyCache.get(key);

  let candidates = [];
  if (track.artist) {
    candidates = await spotify.search(`track:${track.title} artist:${track.artist}`, 5);
  }
  if (!candidates.length) candidates = await spotify.search(`${track.artist} ${track.title}`, 5);

  const best = pickBest(track, candidates, scoreSpotifyCandidate);
  spotifyCache.set(key, best || null);
  return best || null;
}

// Completa a faixa com o ID que estiver faltando. Erros não impedem a faixa de entrar na fila.
async function completeTrack(track) {
  const out = { ...track, matchErrors: [] };
  try {
    if (!out.youtubeId && out.spotifyUri) out.youtubeId = await findOnYoutube(out);
  } catch (err) {
    out.matchErrors.push(err.message);
  }
  try {
    if (!out.spotifyUri && out.youtubeId) {
      const sp = await findOnSpotify(out);
      if (sp) {
        // Metadados do Spotify são mais limpos; mantém a duração do vídeo que já está tocando.
        Object.assign(out, { spotifyUri: sp.spotifyUri, title: sp.title, artist: sp.artist, isrc: sp.isrc, art: out.art || sp.art });
      }
    }
  } catch (err) {
    out.matchErrors.push(err.message);
  }
  return out;
}

module.exports = { completeTrack, findOnYoutube, findOnSpotify };
