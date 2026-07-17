// GET /api/movies/ratings?imdb=tt...&title=...&year=...
// Aggregates ratings across IMDb, Rotten Tomatoes, FilmAffinity (+ Metacritic
// & TMDb when API keys are configured) and returns metadata + a /10 average.
import { aggregate, json } from './_lib.js';

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

  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  try {
    const data = await aggregate({ imdbId, title, year, env, fresh, type });
    const cacheable = json(data); // Cache-Control 6h por defecto
    // Un "recalcular" también refresca la copia del edge para el resto.
    context.waitUntil(cache.put(cacheKey, cacheable.clone()));
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
