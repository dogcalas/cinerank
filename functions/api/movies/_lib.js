// Shared helpers for the movie-rating aggregator.
// Runs server-side on Cloudflare Pages Functions (the edge), so there are no
// CORS restrictions and requests come from a real server IP — this is the only
// place scraping the rating sites can work reliably.
//
// Design principle: every source is fetched inside its own try/catch. A source
// that changes its markup or times out simply returns null and drops out of the
// average; it never breaks the whole response.

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

export const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=21600', // 6h — ratings move slowly
      ...extraHeaders,
    },
  });

// fetch with a hard timeout so one slow source can't hang the whole request
async function fetchText(url, { timeout = 9000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, ...headers },
      signal: ctrl.signal,
      cf: { cacheTtl: 21600, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

// Cloudflare Browser Rendering (REST): renders the page in a real headless
// browser and returns its HTML. Bypasses the anti-bot walls that block plain
// fetch (IMDb responde 202-challenge, FilmAffinity 403). Requires
// CF_ACCOUNT_ID + CF_API_TOKEN (token with Browser Rendering permission).
async function renderViaCf(url, env, { timeout = 25000 } = {}) {
  if (!env || !env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          rejectResourceTypes: ['image', 'media', 'font', 'stylesheet'],
          gotoOptions: { waitUntil: 'domcontentloaded', timeout: timeout - 5000 },
        }),
        signal: ctrl.signal,
      }
    );
    const data = await res.json();
    return data && data.success && data.result ? data.result : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---------- text utilities ----------

export function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (combining diacritics)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ISO-8601 duration ("PT2H28M") -> minutes
export function isoDurationToMinutes(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const total = h * 60 + min;
  return total > 0 ? total : null;
}

function firstJsonLd(html, wantType = 'Movie') {
  const blocks = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  for (const b of blocks) {
    try {
      let parsed = JSON.parse(b[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of arr) {
        const type = node && node['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.some((t) => String(t).includes(wantType)) || node.aggregateRating)
          return node;
      }
    } catch (_) {
      /* ignore malformed block */
    }
  }
  return null;
}

// ---------- SEARCH: IMDb suggestion API (no key required) ----------

export async function searchImdb(query) {
  const q = query.trim();
  const first = q[0] ? q[0].toLowerCase() : 'a';
  const url =
    `https://v3.sg.media-imdb.com/suggestion/${encodeURIComponent(first)}/` +
    `${encodeURIComponent(q)}.json?includeVideos=0`;
  const data = await fetchJson(url, { timeout: 8000 });
  const allowed = new Set([
    'feature', 'tvMovie', 'video', 'tvSeries', 'tvMiniSeries', 'short', 'documentary',
  ]);
  return (data.d || [])
    .filter((it) => typeof it.id === 'string' && it.id.startsWith('tt'))
    .filter((it) => !it.q || allowed.has(it.q))
    .slice(0, 12)
    .map((it) => ({
      imdbId: it.id,
      title: it.l,
      year: it.y || null,
      type: it.q || 'feature',
      cast: it.s || '',
      poster: it.i ? it.i.imageUrl : null,
    }));
}

// ---------- per-source rating scrapers ----------
// Each returns { source, key, native, value, scale, url, votes? } or null.

// IMDb: scrape the title page JSON-LD (rating + rich metadata). No key.
// IMDb suele responder 202 con una página-challenge anti-bot a fetch plano;
// en ese caso reintenta vía Browser Rendering si hay credenciales.
async function fromImdb(imdbId, env) {
  const pageUrl = `https://www.imdb.com/title/${imdbId}/`;
  let html = '';
  try {
    html = await fetchText(pageUrl, {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
  } catch (_) {
    /* fall through to browser rendering */
  }
  let ld = firstJsonLd(html);
  if (!ld) {
    const rendered = await renderViaCf(pageUrl, env);
    if (rendered) ld = firstJsonLd(rendered);
  }
  ld = ld || {};
  const agg = ld.aggregateRating;
  const rating = agg ? parseFloat(agg.ratingValue) : null;
  const meta = {
    title: ld.name || null,
    year:
      (ld.datePublished && ld.datePublished.slice(0, 4)) || null,
    genres: ld.genre ? [].concat(ld.genre) : [],
    runtime: isoDurationToMinutes(ld.duration),
    plot: ld.description || null,
    poster: ld.image || null,
    contentRating: ld.contentRating || null,
    director: ld.director
      ? []
          .concat(ld.director)
          .map((d) => d.name)
          .filter(Boolean)
      : [],
  };
  const rec =
    rating != null && !Number.isNaN(rating)
      ? {
          source: 'IMDb',
          key: 'imdb',
          prio: 1,
          native: `${rating.toFixed(1)}/10`,
          value: rating,
          scale: 10,
          votes: agg && agg.ratingCount ? Number(agg.ratingCount) : null,
          url: pageUrl,
        }
      : null;
  return { rec, meta };
}

// Rotten Tomatoes: the old /napi/search endpoint was removed (404). The HTML
// search page still works without a key: each result is a
// <search-page-media-row> with release-year + tomatometer-score attributes.
// The film page then carries both scores in a <script id="media-scorecard-json">.
async function fromRottenTomatoes(title, year) {
  const searchHtml = await fetchText(
    `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`,
    { timeout: 9000 }
  );
  const rows = [...searchHtml.matchAll(
    /<search-page-media-row([\s\S]*?)<\/search-page-media-row>/g
  )];
  const want = normalizeTitle(title);
  let best = null;
  for (const row of rows) {
    const block = row[0];
    const href = (block.match(
      /href="(https:\/\/www\.rottentomatoes\.com\/m\/[^"]+)"/
    ) || [])[1];
    if (!href) continue; // solo películas (/m/); descarta series (/tv/)
    const attr = (name) => {
      const m = block.match(new RegExp(`${name}="([^"]*)"`));
      return m ? m[1] : '';
    };
    const nameM = block.match(/slot="title"[^>]*>([\s\S]*?)<\/a>/);
    const name = nameM ? nameM[1].trim() : '';
    let score = 0;
    const n = normalizeTitle(name);
    if (n === want) score += 3;
    else if (n.includes(want) || want.includes(n)) score += 1;
    const yr = attr('release-year');
    if (year && yr && Math.abs(Number(yr) - Number(year)) <= 1) score += 2;
    const tomato = attr('tomatometer-score');
    if (!best || score > best.score)
      best = { href, score, tomato: tomato !== '' ? Number(tomato) : null };
  }
  if (!best || best.score === 0) return null;

  // La página de la ficha añade el score del público (Popcornmeter); si falla,
  // nos quedamos al menos con el Tomatómetro de la búsqueda.
  let critics = best.tomato;
  let audience = null;
  const rtUrl = best.href;
  try {
    const filmHtml = await fetchText(rtUrl, { timeout: 9000 });
    const m = filmHtml.match(
      /<script[^>]*id="media-scorecard-json"[^>]*>([\s\S]*?)<\/script>/
    );
    if (m) {
      const sc = JSON.parse(m[1]);
      const c = sc.criticsScore && sc.criticsScore.score;
      const a = sc.audienceScore && sc.audienceScore.score;
      if (c != null && c !== '' && !Number.isNaN(Number(c))) critics = Number(c);
      if (a != null && a !== '' && !Number.isNaN(Number(a))) audience = Number(a);
    }
  } catch (_) {
    /* keep search-page tomatometer */
  }

  const recs = [];
  if (critics != null && !Number.isNaN(Number(critics)))
    recs.push({
      source: 'Rotten Tomatoes',
      key: 'rt_critics',
      prio: 1,
      label: 'Tomatómetro',
      native: `${Number(critics)}%`,
      value: Number(critics),
      scale: 100,
      url: rtUrl,
    });
  if (audience != null && !Number.isNaN(Number(audience)))
    recs.push({
      source: 'RT Audiencia',
      key: 'rt_audience',
      prio: 1,
      label: 'Público',
      native: `${Number(audience)}%`,
      value: Number(audience),
      scale: 100,
      url: rtUrl,
    });
  return recs.length ? recs : null;
}

// Filmaffinity: no API — scrape the search page, then the film page's rating.
// FilmAffinity devuelve 403 a fetch plano desde datacenter; cada página se
// reintenta vía Browser Rendering cuando hay credenciales.
async function fromFilmaffinity(title, year, env) {
  const getHtml = async (url) => {
    try {
      return await fetchText(url, { timeout: 9000 });
    } catch (e) {
      const rendered = await renderViaCf(url, env);
      if (rendered) return rendered;
      throw e;
    }
  };
  const searchUrl =
    `https://www.filmaffinity.com/es/search.php?stext=` +
    encodeURIComponent(title);
  let html = await getHtml(searchUrl);

  // A single hit redirects straight to the film page; multiple hits show a list.
  const isFilmPage = /property=["']og:url["'][^>]*film\d+\.html/.test(html) ||
    /<body[^>]*id=["']film-page/.test(html);

  if (!isFilmPage) {
    const link = html.match(/\/es\/film(\d+)\.html/);
    if (!link) return null;
    html = await getHtml(`https://www.filmaffinity.com/es/film${link[1]}.html`);
  }

  let value = null;
  const ld = firstJsonLd(html);
  if (ld && ld.aggregateRating && ld.aggregateRating.ratingValue != null) {
    value = parseFloat(String(ld.aggregateRating.ratingValue).replace(',', '.'));
  }
  if (value == null) {
    const m =
      html.match(/itemprop=["']ratingValue["'][^>]*content=["']([\d.,]+)["']/) ||
      html.match(/id=["']movie-rat-avg["'][^>]*>\s*([\d.,]+)/);
    if (m) value = parseFloat(m[1].replace(',', '.'));
  }
  if (value == null || Number.isNaN(value)) return null;

  const urlMatch = html.match(/\/es\/film\d+\.html/);
  return {
    source: 'FilmAffinity',
    key: 'filmaffinity',
    prio: 1,
    native: `${value.toFixed(1)}/10`,
    value,
    scale: 10,
    url: urlMatch ? `https://www.filmaffinity.com${urlMatch[0]}` : searchUrl,
  };
}

// OMDb (optional API key): reliable IMDb + RT + Metacritic + solid metadata.
async function fromOmdb(imdbId, apiKey) {
  const data = await fetchJson(
    `https://www.omdbapi.com/?apikey=${apiKey}&i=${imdbId}&plot=short`,
    { timeout: 8000 }
  );
  if (!data || data.Response === 'False') return null;
  const recs = [];
  for (const r of data.Ratings || []) {
    if (r.Source === 'Metacritic') {
      const v = parseInt(r.Value, 10);
      if (!Number.isNaN(v))
        recs.push({
          source: 'Metacritic',
          key: 'metacritic',
          prio: 1,
          native: `${v}/100`,
          value: v,
          scale: 100,
          url: null,
        });
    }
    // Respaldo del Tomatómetro cuando el scraping de RT no encuentra la ficha.
    if (r.Source === 'Rotten Tomatoes') {
      const v = parseInt(r.Value, 10);
      if (!Number.isNaN(v))
        recs.push({
          source: 'Rotten Tomatoes',
          key: 'rt_critics',
          prio: 2,
          label: 'Tomatómetro',
          native: `${v}%`,
          value: v,
          scale: 100,
          url: null,
        });
    }
  }
  // Respaldo de la nota IMDb cuando la ficha está tras el challenge anti-bot.
  const imdbRating = parseFloat(data.imdbRating);
  if (data.imdbRating && data.imdbRating !== 'N/A' && !Number.isNaN(imdbRating))
    recs.push({
      source: 'IMDb',
      key: 'imdb',
      prio: 2,
      native: `${imdbRating.toFixed(1)}/10`,
      value: imdbRating,
      scale: 10,
      votes:
        data.imdbVotes && data.imdbVotes !== 'N/A'
          ? Number(data.imdbVotes.replace(/,/g, ''))
          : null,
      url: `https://www.imdb.com/title/${imdbId}/`,
    });
  const meta = {
    title: data.Title || null,
    year: data.Year || null,
    genres: data.Genre ? data.Genre.split(',').map((s) => s.trim()) : [],
    runtime: data.Runtime && /\d+/.test(data.Runtime)
      ? parseInt(data.Runtime, 10)
      : null,
    plot: data.Plot && data.Plot !== 'N/A' ? data.Plot : null,
    poster: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
    director: data.Director && data.Director !== 'N/A'
      ? data.Director.split(',').map((s) => s.trim())
      : [],
    country: data.Country && data.Country !== 'N/A' ? data.Country : null,
    contentRating: data.Rated && data.Rated !== 'N/A' ? data.Rated : null,
  };
  return { recs, meta };
}

// TMDb (optional API key): adds the TMDb community score + metadata backup.
async function fromTmdb(imdbId, apiKey) {
  const data = await fetchJson(
    `https://api.themoviedb.org/3/find/${imdbId}` +
      `?external_source=imdb_id&api_key=${apiKey}&language=es-ES`,
    { timeout: 8000 }
  );
  const hit = (data.movie_results && data.movie_results[0]) ||
    (data.tv_results && data.tv_results[0]);
  if (!hit) return null;
  const rating = hit.vote_average ? Number(hit.vote_average) : null;
  const rec =
    rating != null && rating > 0
      ? {
          source: 'TMDb',
          key: 'tmdb',
          prio: 1,
          native: `${rating.toFixed(1)}/10`,
          value: rating,
          scale: 10,
          votes: hit.vote_count || null,
          url: `https://www.themoviedb.org/movie/${hit.id}`,
        }
      : null;
  const meta = {
    title: hit.title || hit.name || null,
    year: (hit.release_date || hit.first_air_date || '').slice(0, 4) || null,
    plot: hit.overview || null,
    poster: hit.poster_path
      ? `https://image.tmdb.org/t/p/w500${hit.poster_path}`
      : null,
  };
  return { rec, meta };
}

// ---------- aggregation ----------

function mergeMeta(base, incoming) {
  if (!incoming) return base;
  const out = { ...base };
  for (const k of Object.keys(incoming)) {
    const v = incoming[k];
    const empty =
      out[k] == null ||
      out[k] === '' ||
      (Array.isArray(out[k]) && out[k].length === 0);
    if (empty && v != null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  return out;
}

export async function aggregate({ imdbId, title, year, env }) {
  const meta = {
    title: title || null,
    year: year || null,
    genres: [],
    runtime: null,
    plot: null,
    poster: null,
    director: [],
    country: null,
    contentRating: null,
  };
  const ratings = [];
  const errors = [];

  // Kick off every source in parallel; settle so one failure can't sink the rest.
  const tasks = [
    fromImdb(imdbId, env)
      .then((r) => {
        if (r.rec) ratings.push(r.rec);
        Object.assign(meta, mergeMeta(meta, r.meta));
      })
      .catch((e) => errors.push({ source: 'IMDb', error: String(e) })),

    fromFilmaffinity(title, year, env)
      .then((r) => r && ratings.push(r))
      .catch((e) => errors.push({ source: 'FilmAffinity', error: String(e) })),

    fromRottenTomatoes(title, year)
      .then((r) => r && r.forEach((x) => ratings.push(x)))
      .catch((e) => errors.push({ source: 'Rotten Tomatoes', error: String(e) })),
  ];

  if (env && env.OMDB_API_KEY) {
    tasks.push(
      fromOmdb(imdbId, env.OMDB_API_KEY)
        .then((r) => {
          if (r) {
            r.recs.forEach((x) => ratings.push(x));
            Object.assign(meta, mergeMeta(meta, r.meta));
          }
        })
        .catch((e) => errors.push({ source: 'OMDb', error: String(e) }))
    );
  }
  if (env && env.TMDB_API_KEY) {
    tasks.push(
      fromTmdb(imdbId, env.TMDB_API_KEY)
        .then((r) => {
          if (r) {
            if (r.rec) ratings.push(r.rec);
            Object.assign(meta, mergeMeta(meta, r.meta));
          }
        })
        .catch((e) => errors.push({ source: 'TMDb', error: String(e) }))
    );
  }

  await Promise.allSettled(tasks);

  // De-duplicate by key (prefer the direct source, prio 1, over the OMDb
  // backup, prio 2 — push order depends on which fetch resolves first).
  const seen = new Set();
  const unique = ratings
    .slice()
    .sort((a, b) => (a.prio || 1) - (b.prio || 1))
    .filter((r) => {
      if (seen.has(r.key)) return false;
      seen.add(r.key);
      return true;
    })
    .map(({ prio, ...r }) => r);
  const normalized = unique.map((r) => (r.value / r.scale) * 10);
  const average = normalized.length
    ? Math.round(
        (normalized.reduce((a, b) => a + b, 0) / normalized.length) * 10
      ) / 10
    : null;

  return {
    imdbId,
    meta,
    ratings: unique.map((r) => ({
      ...r,
      normalized: Math.round(((r.value / r.scale) * 10) * 10) / 10,
    })),
    average,
    sourceCount: unique.length,
    errors,
  };
}
