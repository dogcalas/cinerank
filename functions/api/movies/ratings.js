// GET /api/movies/ratings?imdb=tt...&title=...&year=...
// Aggregates ratings across IMDb, Rotten Tomatoes, FilmAffinity (+ Metacritic
// & TMDb when API keys are configured) and returns metadata + a /10 average.
import { aggregate, json } from './_lib.js';

export async function onRequestGet({ request, env }) {
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
  try {
    const data = await aggregate({ imdbId, title, year, env, fresh, type });
    return json(data, 200, fresh ? { 'Cache-Control': 'no-store' } : {});
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
