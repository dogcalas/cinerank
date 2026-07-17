// TEMPORAL: inspecciona lo que el edge recibe de las fuentes de FilmAffinity.
// Restringido a hosts concretos para no ser un proxy abierto. Eliminar
// cuando termine la depuración.
import { renderViaCf, fetchDebug, json } from './_lib.js';

const ALLOWED = /^https:\/\/(www\.filmaffinity\.com|www\.imdb\.com|query\.wikidata\.org|archive\.org|web\.archive\.org)\//;

export async function onRequestGet({ request, env }) {
  const p = new URL(request.url).searchParams;
  const u = p.get('url') || '';
  if (!ALLOWED.test(u)) {
    return json({ error: 'host no permitido' }, 400);
  }
  try {
    const html =
      p.get('mode') === 'fetch'
        ? await fetchDebug(u)
        : await renderViaCf(u, env, {
            timeout: Number(p.get('timeout')) || 25000,
            waitUntil: p.get('waitUntil') || 'domcontentloaded',
            waitMs: Number(p.get('waitMs')) || 0,
          });
    return json(
      {
        ok: true,
        length: html.length,
        hasFilmLink: /\/es\/film\d+\.html/.test(html),
        hasRating: /ratingValue/.test(html),
        title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || null,
        head: html.slice(0, 1500),
      },
      200,
      { 'Cache-Control': 'no-store' }
    );
  } catch (e) {
    return json({ ok: false, error: String(e) }, 200, { 'Cache-Control': 'no-store' });
  }
}
