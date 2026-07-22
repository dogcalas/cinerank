// GET /sitemap.xml
// Portada + todas las fichas de película conocidas. Las fichas se registran
// en KV (binding CINERANK_KV) cada vez que alguien —usuario o bot— visita
// /pelicula/<slug>. Sin KV vinculado, el sitemap lista solo la portada.
//
// GET /sitemap.xml?debug=1 → JSON de diagnóstico: si el binding está presente
// en ESTA función, cuántas claves movie: ve el list(), y un error si lo hubo.
import { SITE_ORIGIN } from './api/movies/_lib.js';

export async function onRequestGet({ env, request }) {
  const debug = new URL(request.url).searchParams.get('debug') === '1';
  const urls = [{ loc: `${SITE_ORIGIN}/`, priority: '1.0' }];
  const dbg = { hasBinding: !!(env && env.CINERANK_KV), listed: 0, error: null, sample: [] };

  if (env && env.CINERANK_KV) {
    try {
      let cursor;
      do {
        const page = await env.CINERANK_KV.list({ prefix: 'movie:', cursor, limit: 1000 });
        for (const k of page.keys) {
          urls.push({
            loc: `${SITE_ORIGIN}/pelicula/${k.name.slice('movie:'.length)}`,
            priority: '0.8',
          });
          if (dbg.sample.length < 5) dbg.sample.push(k.name);
        }
        dbg.listed += page.keys.length;
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
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
      .map((u) => `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>`)
      .join('\n') +
    '\n</urlset>\n';

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
