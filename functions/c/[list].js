// GET /c/<slug>,<slug>,…[?lang=es|en]  — comparación compartible.
// Sirve la propia SPA (index.html) con el <head> reescrito para que el enlace
// tenga su propio snippet al compartirse ("Origen vs Interstellar — CineRank").
// El cliente lee la ruta al arrancar y carga esas películas en la comparación,
// y el parámetro lang fija el idioma de la interfaz para quien abre el enlace.
// noindex: son combinaciones infinitas generadas por usuarios; indexarlas
// diluiría el SEO de las fichas y la portada.
import { parseSlug, escapeHtml as esc, SITE_ORIGIN } from '../api/movies/_lib.js';

const cap = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

const L10N = {
  es: {
    title: (vs) => `${vs} — ¿cuál ver? | CineRank`,
    desc: (names) =>
      `Comparación de ${names.length} título${names.length === 1 ? '' : 's'}: ${names.join(', ')}. ` +
      'Notas de IMDb, Rotten Tomatoes, FilmAffinity, Metacritic y Letterboxd con media agregada.',
  },
  en: {
    title: (vs) => `${vs} — which one to watch? | CineRank`,
    desc: (names) =>
      `Comparing ${names.length} title${names.length === 1 ? '' : 's'}: ${names.join(', ')}. ` +
      'Scores from IMDb, Rotten Tomatoes, FilmAffinity, Metacritic and Letterboxd with an aggregate average.',
  },
};

export async function onRequestGet({ request, env, params }) {
  const slugs = String(params.list || '').split(',').map(parseSlug).filter(Boolean);
  if (!slugs.length) return Response.redirect(SITE_ORIGIN, 302);

  const reqUrl = new URL(request.url);
  const qLang = reqUrl.searchParams.get('lang');
  const accept = request.headers.get('Accept-Language') || '';
  const lang =
    qLang === 'es' || qLang === 'en'
      ? qLang
      : accept && !/(^|[,\s])es(-|[;,\s]|$)/i.test(accept)
        ? 'en'
        : 'es';
  const L = L10N[lang];

  const asset = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  let html = await asset.text();

  const names = slugs.map((s) => `${cap(s.title)}${s.year ? ` (${s.year})` : ''}`);
  const title = L.title(names.join(' vs '));
  const desc = L.desc(names);
  const url = `${SITE_ORIGIN}/c/${params.list}?lang=${lang}`;

  html = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta name="robots" content=")[^"]*(")/, '$1noindex, follow$2')
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${esc(url)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${esc(url)}$2`);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      Vary: 'Accept-Language',
    },
  });
}
