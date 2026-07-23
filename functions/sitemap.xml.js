// GET /sitemap.xml
// Portada + las últimas 200 fichas de película registradas. Una ficha entra en
// KV (binding CINERANK_KV) en cuanto se generan sus notas —al cargar sus
// estadísticas desde /api/movies/ratings o al abrir /pelicula/<slug>—, no hace
// falta que alguien visite la ficha. Cada clave movie:<slug> lleva en su
// metadata el timestamp del último registro; aquí ordenamos por ese timestamp
// (más recientes primero) y nos quedamos con MAX_URLS para que el sitemap no
// crezca sin límite. Sin KV vinculado, el sitemap lista solo la portada.
//
// GET /sitemap.xml?debug=1 → JSON de diagnóstico: si el binding está presente
// en ESTA función, cuántas claves movie: ve el list(), cuántas se emiten y un
// error si lo hubo.
import { SITE_ORIGIN } from './api/movies/_lib.js';

const MAX_URLS = 200;

export async function onRequestGet({ env, request }) {
  const debug = new URL(request.url).searchParams.get('debug') === '1';
  const urls = [{ loc: `${SITE_ORIGIN}/`, priority: '1.0', lastmod: null }];
  const dbg = { hasBinding: !!(env && env.CINERANK_KV), listed: 0, emitted: 0, error: null, sample: [] };

  if (env && env.CINERANK_KV) {
    try {
      // Recogemos todas las claves con su timestamp; list() las devuelve por
      // orden alfabético, así que hay que leerlas todas para poder ordenar por
      // recencia antes de recortar a las últimas MAX_URLS.
      const entries = [];
      let cursor;
      do {
        const page = await env.CINERANK_KV.list({ prefix: 'movie:', cursor, limit: 1000 });
        for (const k of page.keys) {
          entries.push({
            slug: k.name.slice('movie:'.length),
            t: (k.metadata && k.metadata.t) || 0,
          });
        }
        dbg.listed += page.keys.length;
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);

      entries.sort((a, b) => b.t - a.t); // más recientes primero
      for (const e of entries.slice(0, MAX_URLS)) {
        urls.push({
          loc: `${SITE_ORIGIN}/pelicula/${e.slug}`,
          priority: '0.8',
          lastmod: e.t ? new Date(e.t).toISOString().slice(0, 10) : null,
        });
        if (dbg.sample.length < 5) dbg.sample.push(e.slug);
      }
      dbg.emitted = Math.min(entries.length, MAX_URLS);
    } catch (e) {
      dbg.error = String(e); // KV caído: sitemap mínimo antes que error
    }
  }

  if (debug) {
    return new Response(JSON.stringify(dbg, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`
      )
      .join('\n') +
    '\n</urlset>\n';

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
