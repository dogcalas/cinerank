// GET /api/movies/ratings?imdb=tt...&title=...&year=...
// Aggregates ratings across IMDb, Rotten Tomatoes, FilmAffinity (+ Metacritic
// & TMDb when API keys are configured) and returns metadata + a /10 average.
import { aggregate, json, slugify } from './_lib.js';

// Versión del esquema de la respuesta de aggregate() (ver _lib.js `version`).
// Va en la clave del KV: al subirla, las entradas viejas quedan huérfanas y
// expiran solas, así un cambio de formato no sirve datos con la forma antigua.
const KV_SCHEMA = 'v3';
const DAY = 86400; // 1 día
const YEAR = 31536000; // 1 año

// TTL del KV según la antigüedad del título. Las pelis/series de años pasados
// casi no cambian sus notas → 1 año. Las del año en curso (o series en emisión,
// "2016–") todavía se mueven → 1 día. Sin año conocido, jugamos seguro con 1 día.
function kvTtlFor(meta) {
  const nowYear = new Date().getUTCFullYear();
  const ys = String((meta && meta.year) || '').trim();
  const ongoing = /[–-]\s*$/.test(ys); // rango abierto: serie en emisión
  const nums = ys.match(/\d{4}/g);
  const latest = nums ? Math.max(...nums.map(Number)) : null;
  if (ongoing || latest == null || latest >= nowYear) return DAY;
  return YEAR;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  const imdbId = p.get('imdb') || '';
  const title = p.get('title') || '';
  const year = p.get('year') || '';
  // fresh=1 (botón "recalcular"): salta la caché de las fuentes y no cachea la respuesta
  const fresh = p.get('fresh') === '1';
  const type = p.get('type') || ''; // feature | tvSeries | tvMiniSeries | …

  if (!/^tt\d+$/.test(imdbId)) {
    return json({ error: 'Falta un imdbId válido (tt…).' }, 400);
  }

  // Caché en el edge (compartida entre usuarios) además de la del navegador:
  // clave canónica sin los parámetros volátiles (t, fresh).
  const canonical = new URL(request.url);
  canonical.searchParams.delete('t');
  canonical.searchParams.delete('fresh');
  canonical.searchParams.sort();
  const cacheKey = new Request(canonical.toString());
  const cache = caches.default;

  // Capa KV (opcional): sobrevive a despliegues y dura mucho más que el edge.
  // Si el binding RATINGS_KV no está configurado, todo sigue igual que antes.
  const KV = env && env.RATINGS_KV;
  const kvKey = `r:${KV_SCHEMA}:${imdbId}:${type || 'x'}`;

  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    // Miss en el edge → probamos KV antes de rascar todas las fuentes.
    if (KV) {
      try {
        const cached = await KV.get(kvKey, { type: 'json' });
        if (cached) {
          const resp = json(cached); // Cache-Control 6h → repuebla navegador + edge
          context.waitUntil(cache.put(cacheKey, resp.clone()));
          return resp;
        }
      } catch (_) {
        // KV caído/no disponible: seguimos al camino normal sin romper nada.
      }
    }
  }
  try {
    const data = await aggregate({ imdbId, title, year, env, fresh, type });
    const cacheable = json(data); // Cache-Control 6h por defecto
    // Un "recalcular" también refresca la copia del edge para el resto.
    context.waitUntil(cache.put(cacheKey, cacheable.clone()));
    // Persistimos en KV solo lo que encontró algo (no cacheamos "sin fuentes"
    // durante un año). El TTL depende de la antigüedad del título.
    if (KV && data && data.sourceCount > 0) {
      context.waitUntil(
        KV.put(kvKey, JSON.stringify(data), { expirationTtl: kvTtlFor(data.meta) })
      );
    }
    // En cuanto una peli tiene notas, ya puede estar en el sitemap: registramos
    // su slug canónico en CINERANK_KV sin esperar a que alguien abra su ficha.
    // El timestamp en la metadata permite al sitemap ordenar por recencia.
    if (env.CINERANK_KV && data && data.sourceCount > 0 && data.meta) {
      const slug = slugify(data.meta.title || title, data.meta.year || year, imdbId);
      context.waitUntil(
        env.CINERANK_KV.put(
          `movie:${slug}`,
          JSON.stringify({ title: data.meta.title, year: data.meta.year }),
          { metadata: { t: Date.now() }, expirationTtl: 31536000 }
        ).catch(() => {})
      );
    }
    return fresh ? json(data, 200, { 'Cache-Control': 'no-store' }) : cacheable;
  } catch (e) {
    return json({ error: `No se pudieron obtener las evaluaciones: ${e}` }, 502);
  }
}

export const onRequestOptions = () =>
  new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });
