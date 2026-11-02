// Funções puras para casar faixas entre Spotify e YouTube.

const NOISE_PATTERNS = [
  /\((official|oficial)[^)]*\)/gi,
  /\[(official|oficial)[^\]]*\]/gi,
  /\((v[ií]deo|clipe|[aá]udio|music video)\s+(official|oficial)[^)]*\)/gi,
  /\[(v[ií]deo|clipe|[aá]udio|music video)\s+(official|oficial)[^\]]*\]/gi,
  /\((lyrics?|letra|legendado|tradu[cç][aã]o|audio|áudio|visuali[sz]er|hd|hq|4k)[^)]*\)/gi,
  /\[(lyrics?|letra|legendado|tradu[cç][aã]o|audio|áudio|visuali[sz]er|hd|hq|4k)[^\]]*\]/gi,
  /\b(official (music )?video|clipe oficial|video oficial|vídeo oficial|official audio)\b/gi,
  /\|.*$/g,
];

// Palavras que indicam uma versão diferente da original.
const VARIANT_WORDS = ['live', 'ao vivo', 'cover', 'remix', 'karaoke', 'instrumental', 'sped up', 'slowed', 'reverb', '8d', 'nightcore', 'acoustic', 'acústico'];

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanYoutubeTitle(title) {
  let t = decodeEntities(title || '');
  for (const re of NOISE_PATTERNS) t = t.replace(re, '');
  // Sobras como "()" ou "[ ]" quando só parte do parêntese era ruído.
  return t.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Extrai { artist, title } de um vídeo do YouTube.
// Canais "Artista - Topic" são os uploads automáticos do YouTube Music.
function parseYoutubeVideo({ title, channelTitle }) {
  const cleaned = cleanYoutubeTitle(title);
  const channel = decodeEntities(channelTitle || '');
  const topic = channel.match(/^(.*) - Topic$/i);
  if (topic) return { artist: topic[1].trim(), title: cleaned };

  const dash = cleaned.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) {
    return { artist: dash[0].trim(), title: dash.slice(1).join(' - ').trim() };
  }
  return { artist: channel.replace(/\s*(VEVO|Official)$/i, '').trim(), title: cleaned };
}

// ISO 8601 (PT4M13S) -> ms
function parseIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
}

function tokenOverlap(a, b) {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / ta.size;
}

function variantPenalty(candidateText, referenceText) {
  const cand = normalize(candidateText);
  const ref = normalize(referenceText);
  let penalty = 0;
  for (const w of VARIANT_WORDS) {
    const re = new RegExp(`\\b${w}\\b`);
    if (re.test(cand) && !re.test(ref)) penalty += 25;
  }
  return penalty;
}

function durationScore(candMs, refMs) {
  if (!candMs || !refMs) return 0;
  const diff = Math.abs(candMs - refMs) / 1000;
  if (diff <= 3) return 30;
  if (diff <= 10) return 15;
  if (diff <= 30) return 0;
  return -30;
}

// ref: { title, artist, durationMs }
// candidates: [{ videoId, title, channelTitle, durationMs }]
function scoreYoutubeCandidate(ref, cand) {
  let score = 0;
  score += tokenOverlap(ref.title, cand.title) * 40;
  score += tokenOverlap(ref.artist, `${cand.title} ${cand.channelTitle}`) * 25;
  if (/ - Topic$/i.test(cand.channelTitle || '')) score += 15;
  score += durationScore(cand.durationMs, ref.durationMs);
  score -= variantPenalty(cand.title, `${ref.title} ${ref.artist}`);
  return score;
}

// candidates: [{ uri, title, artist, durationMs }]
function scoreSpotifyCandidate(ref, cand) {
  let score = 0;
  score += tokenOverlap(ref.title, cand.title) * 45;
  if (ref.artist) score += tokenOverlap(ref.artist, cand.artist) * 30;
  score += durationScore(cand.durationMs, ref.durationMs);
  score -= variantPenalty(cand.title, ref.title);
  return score;
}

// Candidatos com nota mínima, do melhor para o pior.
function rankCandidates(ref, candidates, scorer, minScore = 30) {
  return candidates
    .map((c) => ({ c, s: scorer(ref, c) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

function pickBest(ref, candidates, scorer, minScore = 30) {
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = scorer(ref, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return bestScore >= minScore ? best : null;
}

function parseYoutubeUrl(input) {
  const s = (input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

module.exports = {
  normalize,
  cleanYoutubeTitle,
  parseYoutubeVideo,
  parseIsoDuration,
  scoreYoutubeCandidate,
  scoreSpotifyCandidate,
  pickBest,
  parseYoutubeUrl,
  rankCandidates,
};
