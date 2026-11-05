'use strict';

// Cápsula sonora: artistas e músicas mais ouvidos (API do Spotify) e um resumo por mês.
// O Spotify só informa as últimas 50 reproduções, então o histórico do mês é guardado
// neste aparelho, aos poucos, e pode ser completado com o arquivo de dados da conta.

(() => {
  const STORE_KEY = 'capsule:v1';
  const LIVE_MAX = 6000;
  const LIVE_KEEP_MS = 400 * 24 * 3600_000;
  const MONTH_ARTISTS_MAX = 60;
  const MONTH_TRACKS_MAX = 100;
  const MIN_PLAY_MS = 30_000; // como o Spotify: menos de 30s não conta como reprodução
  const RECENT_EVERY_MS = 20 * 60_000;
  const SONGS_PER_ARTIST = 5;

  const body = $('capsuleBody');
  const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
  const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const num = new Intl.NumberFormat('pt-BR');

  let range = 'short_term';
  const topCache = new Map(); // range -> { artists, tracks }
  let month = monthKey(Date.now());
  let open = false;
  let needsAuth = false;

  // ---------- armazenamento ----------

  // { live: [{t, id, n, a, i, ms}], imp: { until, from, months: { 'AAAA-MM': {ms, plays, artists:{nome:ms}, tracks:{chave:[ms, plays, título, artista]}} } }, img: {artista: url} }
  function load() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch {}
    if (!d || typeof d !== 'object') d = {};
    if (!Array.isArray(d.live)) d.live = [];
    if (!d.img || typeof d.img !== 'object') d.img = {};
    return d;
  }
  let data = load();

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  function monthKey(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    return monthKey(new Date(y, m - 1 + delta, 1).getTime());
  }
  const monthStart = (key) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).getTime();
  };

  // ---------- histórico recente (vai acumulando a cada visita) ----------

  function mergeRecent(items) {
    const seen = new Set(data.live.map((x) => x.t));
    let added = 0;
    for (const it of items) {
      if (!Number.isFinite(it.playedAt) || seen.has(it.playedAt)) continue;
      seen.add(it.playedAt);
      data.live.push({ t: it.playedAt, id: it.id, n: it.title, a: it.artist, i: it.art || '', ms: it.durationMs || 0 });
      added++;
    }
    if (!added) return 0;
    const cutoff = Date.now() - LIVE_KEEP_MS;
    data.live = data.live.filter((x) => x.t >= cutoff).sort((a, b) => a.t - b.t).slice(-LIVE_MAX);
    if (!data.liveSince) data.liveSince = data.live[0]?.t || Date.now();
    save();
    return added;
  }

  let recentBusy = false;
  async function syncRecent({ quiet = true } = {}) {
    if (!config.spotify || recentBusy) return;
    recentBusy = true;
    try {
      const res = await call('capsule:recent');
      if (res.ok && res.needsAuth) {
        needsAuth = true;
      } else if (res.ok) {
        needsAuth = false;
        if (mergeRecent(res.items || []) && open) renderMonth();
      } else if (!quiet) {
        toast(res.error || 'Não foi possível ler seu histórico do Spotify.');
      }
    } finally {
      recentBusy = false;
    }
  }

  // ---------- mais ouvidos ----------

  async function loadTop() {
    const want = range;
    if (!config.spotify) {
      renderTop(null, 'O Spotify ainda não foi configurado neste servidor.');
      return;
    }
    const cached = topCache.get(want);
    if (cached) return renderTop(cached);
    renderTop(null, 'Carregando…');
    const res = await call('capsule:top', { range: want });
    if (want !== range) return;
    if (res.ok && res.needsAuth) {
      needsAuth = true;
      renderConnect();
      return renderTop(null, '');
    }
    if (!res.ok) return renderTop(null, res.error || 'Não foi possível carregar seus mais ouvidos.');
    needsAuth = false;
    renderConnect();
    topCache.set(want, res);
    for (const a of res.artists || []) if (a.art) data.img[a.name] = a.art;
    save();
    renderTop(res);
  }

  function renderConnect() {
    const show = config.spotify && needsAuth;
    $('capConnect').hidden = !show;
    if (show) {
      $('capConnectMsg').textContent =
        'Conecte (ou reconecte) o Spotify para ver seus artistas e músicas mais ouvidos. É preciso autorizar o acesso ao seu histórico.';
    }
  }

  const img = (url, cls = '') => (url ? `<img src="${esc(url)}" alt="" loading="lazy" class="${cls}">` : `<div class="ph ${cls}"></div>`);
  const chev = '<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

  // artists: [{ name, art, sub, songs: [{ title, extra }] }]
  function artistList(el, artists) {
    el.innerHTML = artists
      .map(
        (a, i) => `<li>
          <button class="item cap-artist" type="button" aria-expanded="false" data-i="${i}" ${a.songs.length ? '' : 'disabled'}>
            <span class="rank">${i + 1}</span>
            ${img(a.art)}
            <div class="info"><div class="t">${esc(a.name)}</div><div class="a">${esc(a.sub)}</div></div>
            ${a.songs.length ? chev : ''}
          </button>
          <ul class="cap-songs" hidden>${a.songs
            .map((s) => `<li><span>${esc(s.title)}</span><span class="muted">${esc(s.extra || '')}</span></li>`)
            .join('')}</ul>
        </li>`
      )
      .join('');
    el.querySelectorAll('.cap-artist').forEach((b) => {
      b.onclick = () => {
        const songs = b.nextElementSibling;
        songs.hidden = !songs.hidden;
        b.setAttribute('aria-expanded', String(!songs.hidden));
      };
    });
  }

  // tracks: [{ title, artist, art, count }]
  function trackList(el, tracks) {
    el.innerHTML = tracks
      .map(
        (t, i) => `<li class="item">
          <span class="rank">${i + 1}</span>
          ${img(t.art)}
          <div class="info"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div>
          ${t.count ? `<span class="count">${esc(t.count)}</span>` : ''}
        </li>`
      )
      .join('');
  }

  function renderTop(res, status = '') {
    document.querySelectorAll('#capRangeSeg .seg').forEach((b) => b.classList.toggle('active', b.dataset.range === range));
    const empty = res && !res.artists.length && !res.tracks.length;
    $('capTopStatus').textContent = empty ? 'O Spotify ainda não tem dados suficientes deste período.' : status;
    $('capTopLists').hidden = !res || empty;
    $('capTopStatus').hidden = !$('capTopStatus').textContent;
    const artists = (res?.artists || []).slice(0, 10).map((a) => {
      const songs = (res.tracks || []).filter((t) => t.artists.includes(a.name));
      return {
        name: a.name,
        art: a.art,
        sub: songs.length
          ? `${songs.length} ${songs.length === 1 ? 'música sua' : 'músicas suas'} no top`
          : a.genres.join(', '),
        songs: songs.slice(0, SONGS_PER_ARTIST).map((t) => ({ title: t.title, extra: `#${res.tracks.indexOf(t) + 1}` })),
      };
    });
    artistList($('capArtists'), artists);
    trackList($('capTracks'), (res?.tracks || []).slice(0, 10));
  }

  // ---------- resumo do mês ----------

  function monthSummary(key) {
    const imp = data.imp?.months?.[key];
    const artists = new Map(); // nome -> ms
    const tracks = new Map(); // chave -> { title, artist, art, ms, plays }
    let ms = 0;
    let plays = 0;
    if (imp) {
      ms += imp.ms;
      plays += imp.plays;
      for (const [name, v] of Object.entries(imp.artists)) artists.set(name, v);
      for (const [k, [tms, tp, title, artist]] of Object.entries(imp.tracks)) tracks.set(k, { title, artist, art: '', ms: tms, plays: tp });
    }
    // Do histórico recente só entra o que o arquivo importado ainda não cobre.
    const after = data.imp?.until || 0;
    const start = monthStart(key);
    const end = monthStart(shiftMonth(key, 1));
    const live = data.live.filter((x) => x.t >= start && x.t < end && x.t > after);
    for (const x of live) {
      ms += x.ms;
      plays++;
      artists.set(x.a, (artists.get(x.a) || 0) + x.ms);
      const k = `${x.n}\u0001${x.a}`;
      const t = tracks.get(k) || { title: x.n, artist: x.a, art: '', ms: 0, plays: 0 };
      t.ms += x.ms;
      t.plays++;
      if (x.i) t.art = x.i;
      tracks.set(k, t);
    }
    return { ms, plays, artists, tracks, imported: Boolean(imp), liveCount: live.length };
  }

  const earliestMonth = () => {
    const keys = [...Object.keys(data.imp?.months || {})];
    if (data.live.length) keys.push(monthKey(data.live[0].t));
    return keys.sort()[0] || monthKey(Date.now());
  };

  const playsLabel = (n) => `${num.format(n)} ${n === 1 ? 'vez' : 'vezes'}`;
  const minutesLabel = (ms) => `${num.format(Math.round(ms / 60_000))} min`;

  function renderMonth() {
    const now = monthKey(Date.now());
    const first = earliestMonth();
    if (month > now) month = now;
    const label = monthName.format(new Date(monthStart(month)));
    $('capMonthLabel').textContent = label.charAt(0).toUpperCase() + label.slice(1);
    $('capPrev').disabled = month <= first;
    $('capNext').disabled = month >= now;

    const s = monthSummary(month);
    $('capMinutes').textContent = num.format(Math.round(s.ms / 60_000));
    $('capPlays').textContent = num.format(s.plays);
    $('capArtistCount').textContent = num.format(s.artists.size);

    const notes = [];
    if (s.imported) notes.push(`Inclui o histórico importado do Spotify (até ${dayFmt.format(new Date(data.imp.until))}).`);
    if (s.liveCount) {
      notes.push(
        `Músicas guardadas pelo YouSpot desde ${dayFmt.format(new Date(data.liveSince || data.live[0].t))}; os minutos contam a duração de cada música tocada.`
      );
    }
    if (!s.plays) {
      notes.push(
        config.spotify && !needsAuth
          ? 'Ainda não há histórico deste mês.'
          : 'Ainda não há histórico deste mês. Conecte o Spotify ou importe o arquivo de dados da sua conta.'
      );
    }
    if (month === now && !s.imported) {
      notes.push('O Spotify só informa as últimas 50 músicas: abra o YouSpot de vez em quando (umas 3 horas de música) para não perder nenhuma.');
    }
    $('capCoverage').textContent = notes.join(' ');
    $('capMonthLists').hidden = !s.plays;
    if (!s.plays) return;

    const tracks = [...s.tracks.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms);
    const artists = [...s.artists.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, ms]) => {
        const songs = tracks.filter((t) => t.artist === name);
        return {
          name,
          art: data.img[name] || songs.find((t) => t.art)?.art || '',
          sub: `${minutesLabel(ms)} · ${songs.length} ${songs.length === 1 ? 'música' : 'músicas'}`,
          songs: songs.slice(0, SONGS_PER_ARTIST).map((t) => ({ title: t.title, extra: playsLabel(t.plays) })),
        };
      });
    artistList($('capMonthArtists'), artists);
    trackList(
      $('capMonthTracks'),
      tracks.slice(0, 10).map((t) => ({ ...t, count: playsLabel(t.plays) }))
    );
  }

  // ---------- importação do arquivo de dados do Spotify ----------

  // StreamingHistory_music_0.json (dados da conta), Streaming_History_Audio_*.json e endsong_*.json (estendido).
  const HISTORY_FILE = /(^|\/)(Streaming_History_Audio|StreamingHistory_music|StreamingHistory\d|endsong)[^/]*\.json$/i;

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  // Leitor mínimo de .zip (sem zip64): só extrai os arquivos de histórico.
  async function unzipHistory(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`"${file.name}" não parece ser um .zip válido.`);
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let k = 0; k < count && p + 46 <= buf.length; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!HISTORY_FILE.test(name)) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const bytes = buf.subarray(start, start + size);
      if (method === 0) out.push(dec.decode(bytes));
      else if (method === 8) {
        if (typeof DecompressionStream !== 'function') {
          throw new Error('Este navegador não abre .zip. Extraia o arquivo e escolha os .json de dentro dele.');
        }
        out.push(await inflate(bytes));
      }
    }
    return out;
  }

  // Normaliza as duas versões do arquivo para { t, ms, title, artist }.
  function normalizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    if ('ms_played' in e) {
      const title = e.master_metadata_track_name;
      const artist = e.master_metadata_album_artist_name;
      if (!title || !artist) return null; // podcast, audiolivro ou faixa local sem metadados
      return { t: Date.parse(e.ts), ms: Number(e.ms_played) || 0, title, artist };
    }
    if ('msPlayed' in e && e.trackName && e.artistName) {
      const t = Date.parse(String(e.endTime || '').replace(' ', 'T') + ':00Z');
      return { t, ms: Number(e.msPlayed) || 0, title: e.trackName, artist: e.artistName };
    }
    return null;
  }

  function buildImport(texts) {
    const months = {};
    let from = Infinity;
    let until = 0;
    let total = 0;
    for (const text of texts) {
      let list;
      try { list = JSON.parse(text); } catch { continue; }
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const e = normalizeEntry(raw);
        if (!e || !Number.isFinite(e.t) || e.ms <= 0) continue;
        total++;
        from = Math.min(from, e.t);
        until = Math.max(until, e.t);
        const key = monthKey(e.t);
        const m = (months[key] ||= { ms: 0, plays: 0, artists: {}, tracks: {} });
        m.ms += e.ms;
        m.artists[e.artist] = (m.artists[e.artist] || 0) + e.ms;
        const k = `${e.title}\u0001${e.artist}`;
        const t = (m.tracks[k] ||= [0, 0, e.title, e.artist]);
        t[0] += e.ms;
        if (e.ms >= MIN_PLAY_MS) {
          m.plays++;
          t[1]++;
        }
      }
    }
    if (!total) return null;
    // Corta cada mês aos mais ouvidos para caber no armazenamento do navegador.
    for (const m of Object.values(months)) {
      m.artists = Object.fromEntries(Object.entries(m.artists).sort((a, b) => b[1] - a[1]).slice(0, MONTH_ARTISTS_MAX));
      m.tracks = Object.fromEntries(
        Object.entries(m.tracks).sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0]).slice(0, MONTH_TRACKS_MAX)
      );
    }
    return { from, until, months, total };
  }

  async function importFiles(files) {
    const status = $('capImportStatus');
    status.textContent = 'Lendo o arquivo…';
    try {
      const texts = [];
      for (const f of files) {
        if (/\.zip$/i.test(f.name) || f.type.includes('zip')) texts.push(...(await unzipHistory(f)));
        else texts.push(await f.text());
      }
      const imp = buildImport(texts);
      if (!imp) {
        status.textContent = 'Não encontrei histórico de músicas nesse arquivo. Escolha o .zip que o Spotify mandou (ou os arquivos "Streaming_History_Audio" / "StreamingHistory_music").';
        return;
      }
      const previous = data.imp;
      data.imp = { from: imp.from, until: imp.until, months: imp.months };
      if (!save()) {
        data.imp = previous;
        status.textContent = 'O histórico é grande demais para guardar neste navegador.';
        return;
      }
      status.textContent = `Pronto: ${num.format(imp.total)} reproduções de ${dayFmt.format(new Date(imp.from))} a ${dayFmt.format(new Date(imp.until))}.`;
      month = monthKey(Math.min(Date.now(), imp.until));
      renderMonth();
    } catch (err) {
      status.textContent = err.message || 'Não foi possível ler o arquivo.';
    }
  }

  // ---------- abrir / navegar ----------

  function show() {
    open = true;
    renderConnect();
    renderMonth();
    loadTop();
    syncRecent({ quiet: false });
  }

  // where: 'tab' (dentro da sala) ou 'screen' (tela própria, a partir do início)
  window.openCapsule = (where) => {
    if (where === 'screen') {
      $('capsuleScreenBody').append(body);
      $('home').hidden = true;
      $('room').hidden = true;
      $('capsuleScreen').hidden = false;
      window.scrollTo(0, 0);
      show();
    } else {
      $('tabCapsule').click();
    }
  };

  $('tabCapsule').addEventListener('click', () => {
    $('tab-capsule').append(body);
    show();
  });
  document.querySelectorAll('.tab:not(#tabCapsule)').forEach((b) => b.addEventListener('click', () => (open = false)));

  $('capsuleHomeBtn').onclick = () => window.openCapsule('screen');
  $('capsuleBackBtn').onclick = () => {
    open = false;
    $('capsuleScreen').hidden = true;
    $('home').hidden = false;
  };
  $('capConnectBtn').onclick = () => spotifyLogin({ intent: 'capsule', room: roomCode || '' });
  document.querySelectorAll('#capRangeSeg .seg').forEach((b) => {
    b.onclick = () => {
      range = b.dataset.range;
      loadTop();
    };
  });
  $('capPrev').onclick = () => { month = shiftMonth(month, -1); renderMonth(); };
  $('capNext').onclick = () => { month = shiftMonth(month, 1); renderMonth(); };
  $('capImportBtn').onclick = () => $('capFile').click();
  $('capFile').onchange = () => {
    const files = [...$('capFile').files];
    $('capFile').value = '';
    if (files.length) importFiles(files);
  };

  // Vai guardando o histórico enquanto o YouSpot estiver aberto (inclusive durante a jam).
  configReady.then(() => {
    const tick = () => socket.connected && syncRecent();
    if (socket.connected) tick();
    else socket.once('connect', tick);
    setInterval(tick, RECENT_EVERY_MS);
  });
})();
