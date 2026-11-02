// YouTube: dois modos.
// - Com YOUTUBE_API_KEY: YouTube Data API v3 oficial (cota: search.list = 100, videos.list = 1; 10.000/dia).
// - Sem chave: a mesma API interna que o site do YouTube usa (InnerTube). Não precisa configurar nada
//   e não tem cota, mas não é oficial: pode mudar sem aviso. Erros aparecem no terminal com [youtube].

const { parseIsoDuration, parseYoutubeVideo } = require('./matching');

const apiBase = () => String(process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, '');
const apiKey = () => process.env.YOUTUBE_API_KEY;

const innertubeBase = () => String(process.env.YOUTUBE_INNERTUBE_BASE || 'https://www.youtube.com/youtubei/v1').replace(/\/+$/, '');
const usesApiKey = () => Boolean(apiKey());

// Funciona sempre: sem chave, usa o modo "site".
function isConfigured() {
  return true;
}

function mode() {
  return usesApiKey() ? 'api' : 'site';
}

async function get(endpoint, params) {
  const qs = new URLSearchParams({ ...params, key: apiKey() });
  let res;
  try {
    res = await fetch(`${apiBase()}/${endpoint}?${qs}`);
  } catch (err) {
    throw new Error(`Não foi possível falar com o YouTube (${err.message}).`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') throw new Error('Cota diária da API do YouTube esgotada.');
    throw new Error(`YouTube API: ${body.error?.message || res.status}`);
  }
  return body;
}

async function videosByIdApi(ids) {
  if (!ids.length) return [];
  const body = await get('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') });
  return (body.items || [])
    .filter((v) => v.status?.embeddable !== false)
    .map((v) => {
      const parsed = parseYoutubeVideo({ title: v.snippet.title, channelTitle: v.snippet.channelTitle });
      return {
        youtubeId: v.id,
        rawTitle: v.snippet.title,
        channelTitle: v.snippet.channelTitle,
        title: parsed.title,
        artist: parsed.artist,
        art: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
        durationMs: parseIsoDuration(v.contentDetails?.duration || ''),
        isrc: null,
      };
    });
}

async function searchApi(q, limit = 8) {
  const body = await get('search', {
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10', // Música
    videoEmbeddable: 'true',
    maxResults: String(limit),
    q,
  });
  const ids = (body.items || []).map((i) => i.id?.videoId).filter(Boolean);
  const videos = await videosByIdApi(ids);
  // Mantém a ordem de relevância da busca.
  return ids.map((id) => videos.find((v) => v.youtubeId === id)).filter(Boolean);
}

// ---------- modo sem chave (InnerTube) ----------

const CLIENT = { clientName: 'WEB', clientVersion: '2.20251020.01.00', hl: 'pt', gl: 'BR' };
const ONLY_VIDEOS = 'EgIQAQ%3D%3D'; // filtro "Tipo: vídeo" da busca do site

async function innertube(endpoint, body) {
  let res;
  try {
    res = await fetch(`${innertubeBase()}/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'pt-BR,pt;q=0.9' },
      body: JSON.stringify({ context: { client: CLIENT }, ...body }),
    });
  } catch (err) {
    throw new Error(`Não foi possível falar com o YouTube (${err.message}).`);
  }
  if (!res.ok) {
    console.warn(`[youtube] ${endpoint} -> ${res.status}`);
    throw new Error(`O YouTube recusou a busca (${res.status}). Tente de novo em instantes.`);
  }
  return res.json();
}

// Junta todos os nós com a chave `key`, em qualquer profundidade (o JSON do site muda de forma com frequência).
function collect(node, key, out = []) {
  if (Array.isArray(node)) for (const n of node) collect(n, key, out);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      else collect(v, key, out);
    }
  }
  return out;
}

const text = (t) => (t?.simpleText ?? (t?.runs || []).map((r) => r.text).join('')) || '';

function parseClock(str) {
  const parts = String(str || '').split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

const bestThumb = (thumbs = []) => {
  const pick = thumbs.find((t) => t.width >= 300) || thumbs[thumbs.length - 1];
  return pick?.url?.startsWith('//') ? `https:${pick.url}` : pick?.url || '';
};

function toTrack({ id, rawTitle, channelTitle, durationMs, art }) {
  const parsed = parseYoutubeVideo({ title: rawTitle, channelTitle });
  return { youtubeId: id, rawTitle, channelTitle, title: parsed.title, artist: parsed.artist, art, durationMs, isrc: null };
}

async function searchSite(q, limit = 8) {
  const body = await innertube('search', { query: q, params: decodeURIComponent(ONLY_VIDEOS) });
  const seen = new Set();
  const out = [];
  for (const v of collect(body, 'videoRenderer')) {
    if (!v?.videoId || seen.has(v.videoId) || !/^[\w-]{11}$/.test(v.videoId)) continue;
    const durationMs = parseClock(text(v.lengthText));
    if (!durationMs) continue; // transmissões ao vivo / estreias
    seen.add(v.videoId);
    out.push(
      toTrack({
        id: v.videoId,
        rawTitle: text(v.title),
        channelTitle: text(v.ownerText) || text(v.longBylineText),
        durationMs,
        art: bestThumb(v.thumbnail?.thumbnails),
      })
    );
    if (out.length >= limit) break;
  }
  if (!out.length) console.warn(`[youtube] busca "${q}" sem resultados no modo sem chave`);
  return out;
}

async function videoByIdSite(id) {
  const body = await innertube('player', { videoId: id });
  const d = body?.videoDetails;
  if (d?.videoId === id) {
    if (body.playabilityStatus?.playableInEmbed === false) return null;
    return toTrack({
      id,
      rawTitle: d.title || '',
      channelTitle: d.author || '',
      durationMs: (Number(d.lengthSeconds) || 0) * 1000,
      art: bestThumb(d.thumbnail?.thumbnails),
    });
  }
  // O /player às vezes pede login; a busca pelo próprio id costuma achar o vídeo.
  const hit = (await searchSite(id, 5)).find((v) => v.youtubeId === id);
  return hit || null;
}

const oembedBase = () => String(process.env.YOUTUBE_OEMBED_BASE || 'https://www.youtube.com/oembed').replace(/\/+$/, '');

// O vídeo pode tocar dentro de outro site (player embutido)? Muitos de gravadora não podem.
// Sem chave usa o oEmbed público (401 = incorporação desativada, 404 = removido/privado).
// O /player do InnerTube não serve: chamado de um servidor ele responde UNPLAYABLE para qualquer vídeo.
// Nenhuma checagem pega todos os bloqueios (erro 150 por região/site): o player da página avisa
// e o servidor tenta o próximo candidato (queue:youtubeFailed).
async function isEmbeddable(id) {
  try {
    if (usesApiKey()) return (await videosByIdApi([id])).length > 0;
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    const res = await fetch(`${oembedBase()}?format=json&url=${encodeURIComponent(url)}`);
    return res.status !== 401 && res.status !== 403 && res.status !== 404;
  } catch {
    return true;
  }
}

async function videosById(ids) {
  if (!ids.length) return [];
  if (usesApiKey()) return videosByIdApi(ids);
  const out = [];
  for (const id of ids) {
    const v = await videoByIdSite(id);
    if (v) out.push(v);
  }
  return out;
}

async function search(q, limit = 8) {
  return usesApiKey() ? searchApi(q, limit) : searchSite(q, limit);
}

module.exports = { isConfigured, mode, search, videosById, isEmbeddable, _internals: { parseClock, collect } };
