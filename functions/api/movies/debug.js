// TEMPORAL: inspecciona lo que Browser Rendering recibe de FilmAffinity.
// Restringido a filmaffinity.com para no ser un proxy abierto. Eliminar
// cuando termine la depuración.
import { renderViaCf, json } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url).searchParams.get('url') || '';
  if (!/^https:\/\/www\.filmaffinity\.com\//.test(u)) {
    return json({ error: 'solo URLs de filmaffinity.com' }, 400);
  }
  try {
    const html = await renderViaCf(u, env);
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
