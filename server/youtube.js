// YouTube Data API v3. Custos de cota: search.list = 100, videos.list = 1 (cota padrão 10.000/dia).

const { parseIsoDuration, parseYoutubeVideo } = require('./matching');

const API = 'https://www.googleapis.com/youtube/v3';
const apiKey = () => process.env.YOUTUBE_API_KEY;

function isConfigured() {
  return Boolean(apiKey());
}

async function get(endpoint, params) {
  const qs = new URLSearchParams({ ...params, key: apiKey() });
  const res = await fetch(`${API}/${endpoint}?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') throw new Error('Cota diária da API do YouTube esgotada.');
    throw new Error(`YouTube API: ${body.error?.message || res.status}`);
  }
  return body;
}

async function videosById(ids) {
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
        durationMs: parseIsoDuration(v.contentDetails.duration),
      };
    });
}

async function search(q, limit = 8) {
  const body = await get('search', {
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10', // Música
    videoEmbeddable: 'true',
    maxResults: String(limit),
    q,
  });
  const ids = (body.items || []).map((i) => i.id.videoId).filter(Boolean);
  const videos = await videosById(ids);
  // Mantém a ordem de relevância da busca.
  return ids.map((id) => videos.find((v) => v.youtubeId === id)).filter(Boolean);
}

module.exports = { isConfigured, search, videosById };
