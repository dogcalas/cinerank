// GET /api/movies/search?q=<title>
// Returns candidate movies (IMDb suggestion API — no key needed) so the user
// can pick the exact title before we aggregate ratings.
import { searchImdb, json } from './_lib.js';

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams.get('q') || '';
  if (q.trim().length < 2) {
    return json({ results: [], error: 'La búsqueda necesita al menos 2 caracteres.' }, 400);
  }
  try {
    const results = await searchImdb(q);
    return json({ query: q, results });
  } catch (e) {
    return json({ query: q, results: [], error: `Búsqueda no disponible: ${e}` }, 502);
  }
}

export const onRequestOptions = () =>
  new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });
