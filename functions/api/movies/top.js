// GET /api/movies/top?kind=movie|tv
// Top 5 tendencias del día según TMDb, con su imdbId para poder meterlas
// directamente en la comparación. Requiere TMDB_API_KEY.
import { json } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const kind =
    new URL(request.url).searchParams.get('kind') === 'tv' ? 'tv' : 'movie';
  if (!env.TMDB_API_KEY) {
    return json({ error: 'Falta TMDB_API_KEY para los tops del día.' }, 501);
  }
  try {
    const trending = await (
      await fetch(
        `https://api.themoviedb.org/3/trending/${kind}/day` +
          `?api_key=${env.TMDB_API_KEY}&language=es-ES`
      )
    ).json();

    // Pedimos los external_ids de los primeros 8 en paralelo (alguno puede
    // no tener imdb_id todavía) y nos quedamos con los 5 primeros válidos.
    const candidates = (trending.results || []).slice(0, 8);
    const withIds = await Promise.all(
      candidates.map(async (it) => {
        try {
          const ext = await (
            await fetch(
              `https://api.themoviedb.org/3/${kind}/${it.id}/external_ids` +
                `?api_key=${env.TMDB_API_KEY}`
            )
          ).json();
          return { it, imdbId: ext.imdb_id || null };
        } catch (_) {
          return { it, imdbId: null };
        }
      })
    );

    const results = withIds
      .filter(({ imdbId }) => imdbId && /^tt\d+$/.test(imdbId))
      .slice(0, 5)
      .map(({ it, imdbId }) => ({
        imdbId,
        title: it.title || it.name,
        year: (it.release_date || it.first_air_date || '').slice(0, 4) || null,
        type: kind === 'tv' ? 'tvSeries' : 'feature',
        poster: it.poster_path
          ? `https://image.tmdb.org/t/p/w500${it.poster_path}`
          : null,
      }));

    return json({ kind, results }, 200, {
      'Cache-Control': 'public, max-age=3600', // el top cambia a diario
    });
  } catch (e) {
    return json({ error: `No se pudo obtener el top del día: ${e}` }, 502);
  }
}

export const onRequestOptions = () =>
  new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });
