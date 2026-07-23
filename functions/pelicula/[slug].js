// GET /pelicula/<titulo>-<año>-<ttID>[?lang=es|en]
// Ficha por película renderizada en el edge: HTML completo con los detalles
// (director, género, duración, sinopsis…), todas las notas y la media.
// Al ser server-side, los bots de WhatsApp/Twitter ven su propio snippet
// (OG/Twitter) y Google recibe JSON-LD Movie + AggregateRating, que es lo que
// usa para mostrar estrellas en los resultados de búsqueda.
// Idioma: ?lang explícito > Accept-Language del navegador > español.
import {
  aggregate, searchImdb, slugify, parseSlug, escapeHtml as esc, SITE_ORIGIN,
} from '../api/movies/_lib.js';

const SRC_COLORS = {
  imdb: '#f5c518', rt_critics: '#fa320a', rt_audience: '#fcb320',
  metacritic: '#00ce7a', filmaffinity: '#0f4c9c', letterboxd: '#ff8000', tmdb: '#01b4e4',
};

const L10N = {
  es: {
    srcLabel: {
      imdb: 'IMDb', rt_critics: 'Rotten Tomatoes · Crítica', rt_audience: 'Rotten Tomatoes · Público',
      metacritic: 'Metacritic', filmaffinity: 'FilmAffinity', letterboxd: 'Letterboxd', tmdb: 'TMDb',
    },
    titleSuffix: 'notas y media',
    avgOf: (n) => `media de ${n} fuentes`,
    directedBy: 'Dirigida por',
    series: '📺 Serie',
    min: 'min',
    avgLabel: 'media',
    avgNote: (n, v) =>
      `Media aritmética de ${n} fuente${n === 1 ? '' : 's'} normalizadas a escala 0–10` +
      `${v ? `, con ${v} votos en total` : ''}.`,
    votes: 'votos',
    synopsis: 'Sinopsis',
    compare: '＋ Comparar con otras',
    share: '🔗 Compartir',
    shareCopied: '✓ Enlace copiado',
    where: '¿Dónde verla? · JustWatch ↗',
    back: '← Comparador',
    jw: (title) => `https://www.justwatch.com/es/buscar?q=${encodeURIComponent(title)}`,
    footer: 'Notas obtenidas en tiempo real de fuentes públicas. Datos y logos pertenecen a sus dueños.',
    madeBy: 'Hecho por',
    ogLocale: 'es_ES',
    numLocale: 'es',
  },
  en: {
    srcLabel: {
      imdb: 'IMDb', rt_critics: 'Rotten Tomatoes · Critics', rt_audience: 'Rotten Tomatoes · Audience',
      metacritic: 'Metacritic', filmaffinity: 'FilmAffinity', letterboxd: 'Letterboxd', tmdb: 'TMDb',
    },
    titleSuffix: 'ratings & average',
    avgOf: (n) => `average of ${n} sources`,
    directedBy: 'Directed by',
    series: '📺 Series',
    min: 'min',
    avgLabel: 'avg',
    avgNote: (n, v) =>
      `Arithmetic mean of ${n} source${n === 1 ? '' : 's'} normalized to a 0–10 scale` +
      `${v ? `, with ${v} votes in total` : ''}.`,
    votes: 'votes',
    synopsis: 'Synopsis',
    compare: '＋ Compare with others',
    share: '🔗 Share',
    shareCopied: '✓ Link copied',
    where: 'Where to watch · JustWatch ↗',
    back: '← Comparator',
    jw: (title) => `https://www.justwatch.com/us/search?q=${encodeURIComponent(title)}`,
    footer: 'Ratings fetched live from public sources. Data and logos belong to their owners.',
    madeBy: 'Made by',
    ogLocale: 'en_US',
    numLocale: 'en',
  },
};

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const parsed = parseSlug(params.slug);
  if (!parsed) return new Response('Película no encontrada', { status: 404 });

  const url = new URL(request.url);
  const qLang = url.searchParams.get('lang');
  const accept = request.headers.get('Accept-Language') || '';
  const lang =
    qLang === 'es' || qLang === 'en'
      ? qLang
      : accept && !/(^|[,\s])es(-|[;,\s]|$)/i.test(accept)
        ? 'en'
        : 'es';

  // Caché edge de la ficha renderizada, una copia por idioma.
  const cacheKey = new Request(`${SITE_ORIGIN}/pelicula/${params.slug}?lang=${lang}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // El slug llega en minúsculas y sin acentos; la API de sugerencias de IMDb
  // devuelve el título real (mayúsculas, acentos), el tipo (serie/película) y
  // un póster de respaldo, verificados contra el mismo imdbId.
  let sug = null;
  try {
    sug = (await searchImdb(parsed.title)).find((r) => r.imdbId === parsed.imdbId) || null;
  } catch (_) { /* la ficha funciona igual sin la sugerencia */ }

  const type = url.searchParams.get('type') || (sug && sug.type) || '';
  const isTv = /tv(Series|MiniSeries)/i.test(type);

  let data;
  try {
    data = await aggregate({
      imdbId: parsed.imdbId,
      title: (sug && sug.title) || parsed.title,
      year: (sug && sug.year) || parsed.year,
      env,
      type,
    });
  } catch (e) {
    return new Response(`No se pudo cargar la ficha: ${e}`, { status: 502 });
  }
  if (sug && sug.poster && !data.meta.poster) data.meta.poster = sug.poster;
  const meta = data.meta || {};
  if (!meta.title && !data.ratings.length)
    return new Response('Película no encontrada', { status: 404 });

  // Redirige al slug canónico (301, conservando query) para que solo exista
  // una URL por título.
  const canonicalSlug = slugify(meta.title || parsed.title, meta.year || parsed.year, parsed.imdbId);
  if (params.slug !== canonicalSlug) {
    return Response.redirect(`${SITE_ORIGIN}/pelicula/${canonicalSlug}${url.search}`, 301);
  }
  const canonicalUrl = `${SITE_ORIGIN}/pelicula/${canonicalSlug}`;

  // Registra el slug para el sitemap (si hay KV vinculado; opcional).
  // El timestamp en la metadata deja al sitemap ordenar por recencia y quedarse
  // con las últimas N; TTL de 1 año para que las fichas nunca vistas se limpien solas.
  if (env.CINERANK_KV) {
    context.waitUntil(
      env.CINERANK_KV.put(
        `movie:${canonicalSlug}`,
        JSON.stringify({ title: meta.title, year: meta.year }),
        { metadata: { t: Date.now() }, expirationTtl: 31536000 }
      ).catch(() => {})
    );
  }

  const html = renderPage({ data, meta, canonicalSlug, canonicalUrl, isTv, lang });
  const res = new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 1h en navegador, 24h en el edge: las notas cambian despacio.
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      Vary: 'Accept-Language',
    },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function renderPage({ data, meta, canonicalSlug, canonicalUrl, isTv, lang }) {
  const L = L10N[lang] || L10N.es;
  const title = meta.title || (lang === 'es' ? 'Película' : 'Movie');
  const year = meta.year ? String(meta.year).slice(0, 4) : '';
  const avg = data.average;
  const directors = (meta.director || []).filter(Boolean);
  const genres = meta.genres || [];
  const votes = (data.ratings || []).reduce((a, r) => a + (r.votes || 0), 0);
  const nf = (n) => Number(n).toLocaleString(L.numLocale);

  const titleFull = `${title}${year ? ` (${year})` : ''}`;
  const ratingBits = (data.ratings || [])
    .map((r) => `${L.srcLabel[r.key] || r.source} ${r.native}`)
    .join(' · ');
  const desc =
    (avg != null ? `⭐ ${avg}/10 — ${L.avgOf(data.sourceCount)}. ` : '') +
    (directors.length ? `${L.directedBy} ${directors.join(', ')}. ` : '') +
    (meta.plot ? meta.plot.slice(0, 160) : ratingBits);

  // JSON-LD Movie/TVSeries con AggregateRating: lo que Google necesita para
  // el rich result con estrellas.
  const ld = {
    '@context': 'https://schema.org',
    '@type': isTv ? 'TVSeries' : 'Movie',
    name: title,
    url: canonicalUrl,
    ...(meta.poster ? { image: meta.poster } : {}),
    ...(year ? { datePublished: year } : {}),
    ...(meta.plot ? { description: meta.plot } : {}),
    ...(genres.length ? { genre: genres } : {}),
    ...(meta.runtime ? { duration: `PT${meta.runtime}M` } : {}),
    ...(directors.length
      ? { director: directors.map((d) => ({ '@type': 'Person', name: d })) }
      : {}),
    ...(meta.contentRating ? { contentRating: meta.contentRating } : {}),
    sameAs: [`https://www.imdb.com/title/${data.imdbId}/`],
    ...(avg != null
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: avg,
            bestRating: 10,
            worstRating: 0,
            ratingCount: votes > 0 ? votes : data.sourceCount,
          },
        }
      : {}),
  };

  const statCards = (data.ratings || [])
    .map((r) => {
      const pct = Math.max(3, Math.min(100, r.normalized * 10));
      const inner = `
        <div class="src"><span class="dot" style="background:${SRC_COLORS[r.key] || '#888'}"></span>${esc(L.srcLabel[r.key] || r.source)}</div>
        <div class="val">${esc(r.native)}${r.votes ? ` <small>(${nf(r.votes)} ${L.votes})</small>` : ''}</div>
        <div class="meter"><i style="width:${pct}%;background:${SRC_COLORS[r.key] || '#888'}"></i></div>`;
      return r.url
        ? `<a class="stat" href="${esc(r.url)}" target="_blank" rel="noopener nofollow">${inner}</a>`
        : `<div class="stat">${inner}</div>`;
    })
    .join('');

  const bits = [];
  if (isTv) bits.push(L.series);
  if (meta.runtime) bits.push(`⏱ ${meta.runtime} ${L.min}`);
  if (meta.contentRating) bits.push(esc(meta.contentRating));
  if (meta.country) bits.push(esc(meta.country.split(',')[0].trim()));

  const avgColor = avg == null ? '#52525b' : avg >= 7 ? '#22c55e' : avg >= 5 ? '#eab308' : '#ef4444';

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">

  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-EJK0BW1Z40"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-EJK0BW1Z40');
    // Ficha vista con título legible (page_view solo da el slug de la URL).
    gtag('event', 'view_film', {
      movie_title: ${JSON.stringify(`${title}${year ? ` (${year})` : ""}`)},
      imdb_id: ${JSON.stringify(data.imdbId)},
    });
  </script>

  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(titleFull)} — ${L.titleSuffix} | CineRank</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="alternate" hreflang="es" href="${canonicalUrl}?lang=es">
  <link rel="alternate" hreflang="en" href="${canonicalUrl}?lang=en">
  <link rel="alternate" hreflang="x-default" href="${canonicalUrl}">

  <meta property="og:type" content="${isTv ? 'video.tv_show' : 'video.movie'}">
  <meta property="og:site_name" content="CineRank">
  <meta property="og:title" content="${esc(titleFull)} — ${avg != null ? `⭐ ${avg}/10` : L.titleSuffix} | CineRank">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${canonicalUrl}">
  ${meta.poster ? `<meta property="og:image" content="${esc(meta.poster)}">` : `<meta property="og:image" content="${SITE_ORIGIN}/og.png">`}
  <meta property="og:locale" content="${L.ogLocale}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${esc(titleFull)} — ${avg != null ? `⭐ ${avg}/10` : L.titleSuffix} | CineRank">
  <meta name="twitter:description" content="${esc(desc)}">
  ${meta.poster ? `<meta name="twitter:image" content="${esc(meta.poster)}">` : ''}

  <script type="application/ld+json">${JSON.stringify(ld)}</script>

  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#6366f1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0f; --bg-card: rgba(255,255,255,0.03); --bg-glass: rgba(255,255,255,0.05);
      --border: rgba(255,255,255,0.08); --text: #e4e4e7; --text-muted: #71717a; --text-dim: #52525b;
      --accent: #6366f1; --accent-glow: rgba(99,102,241,0.15);
      --gradient: linear-gradient(135deg, #6366f1, #8b5cf6, #ec4899);
      --font: 'Inter', -apple-system, sans-serif; --mono: 'JetBrains Mono', monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.6;
      min-height: 100vh; -webkit-font-smoothing: antialiased;
      background-image: radial-gradient(circle at 15% 10%, rgba(99,102,241,0.10), transparent 40%),
        radial-gradient(circle at 85% 0%, rgba(236,72,153,0.08), transparent 45%);
      background-attachment: fixed;
    }
    a { color: inherit; text-decoration: none; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 0 1.25rem; }
    header { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(14px); background: rgba(10,10,15,0.72); border-bottom: 1px solid var(--border); }
    .nav { display: flex; align-items: center; justify-content: space-between; height: 62px; }
    .brand { display: flex; align-items: center; gap: 0.6rem; font-weight: 800; letter-spacing: -0.02em; }
    .brand b { background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .back { font-family: var(--mono); font-size: 0.72rem; color: var(--text-muted); border: 1px solid var(--border); padding: 0.4rem 0.8rem; border-radius: 50px; transition: all 0.25s; }
    .back:hover { color: var(--text); border-color: var(--accent); background: var(--accent-glow); }

    .movie { display: grid; grid-template-columns: 300px 1fr; gap: 2rem; margin: 2.5rem 0; align-items: start; }
    @media (max-width: 700px) { .movie { grid-template-columns: 1fr; } .poster { max-width: 300px; margin: 0 auto; } }
    .poster { border-radius: 18px; overflow: hidden; border: 1px solid var(--border); background: #14141c; }
    .poster img { width: 100%; display: block; }
    .poster .noimg { display: flex; align-items: center; justify-content: center; font-size: 4rem; aspect-ratio: 2/3; }
    h1 { font-size: clamp(1.6rem, 4vw, 2.4rem); font-weight: 900; letter-spacing: -0.03em; line-height: 1.15; }
    h1 span { color: var(--text-muted); font-weight: 500; }
    .meta-line { color: var(--text-muted); font-size: 0.9rem; margin: 0.6rem 0 0.4rem; }
    .director { font-size: 0.95rem; margin-bottom: 0.8rem; }
    .director b { font-weight: 600; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1.2rem; }
    .chip { font-family: var(--mono); font-size: 0.68rem; color: #c4b5fd; background: var(--bg-glass); border: 1px solid rgba(139,92,246,0.3); padding: 0.2rem 0.55rem; border-radius: 50px; }
    .avg-row { display: flex; align-items: center; gap: 1.2rem; margin: 1.2rem 0; }
    .avg-badge { width: 92px; height: 92px; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #0e0e14; border: 3px solid ${avgColor}; box-shadow: 0 8px 24px rgba(0,0,0,0.5); flex-shrink: 0; }
    .avg-badge .n { font-family: var(--mono); font-weight: 600; font-size: 1.7rem; line-height: 1; color: ${avgColor}; }
    .avg-badge .n small { font-size: 0.5em; font-weight: 500; color: var(--text-muted); }
    .avg-badge .l { font-size: 0.6rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .avg-note { font-size: 0.85rem; color: var(--text-muted); max-width: 320px; }
    .ratings { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 0.6rem; margin-bottom: 1.5rem; }
    .stat { display: flex; flex-direction: column; gap: 2px; background: var(--bg-glass); border: 1px solid var(--border); border-radius: 12px; padding: 0.6rem 0.75rem; min-width: 0; transition: border-color 0.2s; }
    a.stat:hover { border-color: var(--accent); }
    .stat .src { font-family: var(--mono); font-size: 0.66rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.35rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stat .src .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .stat .val { font-family: var(--mono); font-size: 1.05rem; font-weight: 600; }
    .stat .val small { font-size: 0.65em; color: var(--text-muted); font-weight: 400; }
    .stat .meter { height: 3px; border-radius: 2px; background: rgba(255,255,255,0.06); margin-top: 4px; overflow: hidden; }
    .stat .meter i { display: block; height: 100%; border-radius: 2px; }
    .plot { background: rgba(99,102,241,0.06); border: 1px dashed rgba(99,102,241,0.4); border-radius: 14px; padding: 1rem 1.2rem; margin-bottom: 1.5rem; }
    .plot h2 { font-size: 0.78rem; font-family: var(--mono); color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.4rem; }
    .plot p { color: var(--text-muted); font-size: 0.92rem; }
    .cta-row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
    .cta { font-family: var(--mono); font-size: 0.78rem; padding: 0.6rem 1.1rem; border-radius: 50px; border: 1px solid var(--border); color: var(--text-muted); transition: all 0.2s; cursor: pointer; background: none; }
    .cta:hover { color: var(--text); border-color: var(--accent); background: var(--accent-glow); }
    .cta.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .cta.primary:hover { filter: brightness(1.15); }
    footer { text-align: center; padding: 3rem 1rem; color: var(--text-dim); font-family: var(--mono); font-size: 0.72rem; }
    footer a { color: var(--text-muted); }
    footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <div class="wrap nav">
      <a class="brand" href="/?lang=${lang}"><span>🎬</span> Cine<b>Rank</b></a>
      <a class="back" href="/?lang=${lang}">${L.back}</a>
    </div>
  </header>

  <main class="wrap">
    <article class="movie">
      <div class="poster">
        ${meta.poster ? `<img src="${esc(meta.poster)}" alt="${lang === 'es' ? 'Póster de' : 'Poster of'} ${esc(title)}">` : '<div class="noimg">🎬</div>'}
      </div>
      <div>
        <h1>${esc(title)} ${year ? `<span>(${year})</span>` : ''}</h1>
        ${bits.length ? `<div class="meta-line">${bits.join(' · ')}</div>` : ''}
        ${directors.length ? `<div class="director">🎬 ${L.directedBy} <b>${esc(directors.join(', '))}</b></div>` : ''}
        ${genres.length ? `<div class="chips">${genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}

        <div class="avg-row">
          <div class="avg-badge">
            <span class="n">${avg != null ? `${avg.toFixed(1)}<small>/10</small>` : '—'}</span>
            <span class="l">${L.avgLabel}</span>
          </div>
          <div class="avg-note">${L.avgNote(data.sourceCount, votes ? nf(votes) : null)}</div>
        </div>

        <div class="ratings">${statCards}</div>

        ${meta.plot ? `<section class="plot"><h2>${L.synopsis}</h2><p>${esc(meta.plot)}</p></section>` : ''}

        <div class="cta-row">
          <a class="cta primary" id="compareCta" href="/?add=${canonicalSlug}&lang=${lang}">${L.compare}</a>
          <button class="cta" id="shareBtn">${L.share}</button>
          <a class="cta" data-out="imdb_page" href="https://www.imdb.com/title/${data.imdbId}/" target="_blank" rel="noopener nofollow">IMDb ↗</a>
          <a class="cta" data-out="justwatch" href="${L.jw(title)}" target="_blank" rel="noopener nofollow">${L.where}</a>
        </div>
      </div>
    </article>
  </main>

  <footer class="wrap">
    <p>${L.footer}</p>
    <p>${L.madeBy} <a href="https://github.com/dogcalas" target="_blank" rel="noopener">Abraham Calás</a> · <a href="/?lang=${lang}">CineRank</a></p>
  </footer>

  <script>
    function track(name, params) {
      try { if (window.gtag) window.gtag('event', name, params || {}); } catch (_) {}
    }
    // CTA "comparar": el paso ficha → comparador (el funnel inverso de ?add=).
    document.getElementById('compareCta').addEventListener('click', () => {
      track('click_compare_cta', { imdb_id: ${JSON.stringify(data.imdbId)} });
    });
    document.querySelectorAll('a[data-out]').forEach((a) => {
      a.addEventListener('click', () => track('click_source', { source: a.dataset.out }));
    });
    document.getElementById('shareBtn').addEventListener('click', async () => {
      track('share', { content_type: 'film', item_id: ${JSON.stringify(canonicalSlug)} });
      const link = ${JSON.stringify(canonicalUrl)} + '?lang=${lang}';
      if (navigator.share) {
        try { await navigator.share({ title: document.title, url: link }); return; } catch (_) {}
      }
      try {
        await navigator.clipboard.writeText(link);
        const b = document.getElementById('shareBtn');
        const old = b.textContent;
        b.textContent = ${JSON.stringify(L10N[lang].shareCopied)};
        setTimeout(() => { b.textContent = old; }, 2000);
      } catch (_) { prompt('URL', link); }
    });
  </script>
</body>
</html>`;
}
