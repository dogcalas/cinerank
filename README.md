# 🎬 CineRank — comparador de películas

Busca una película y reúne **todas sus evaluaciones** (IMDb, Rotten Tomatoes,
FilmAffinity y —opcionalmente— Metacritic y TMDb) con una **media agregada**.
Añade varias películas y **compáralas lado a lado** (con duración, género,
director y sinopsis) para decidir cuál ver.

- Front-end estático (`index.html`), sin build, sin dependencias.
- Scraping/lectura de fuentes en el **edge de Cloudflare** (Pages Functions).
- Bilingüe **ES/EN**, tema oscuro, lista de comparación guardada en el navegador.

## Por qué Cloudflare Pages Functions

Las webs de rating no se pueden leer desde el navegador (CORS + bloquean
orígenes de navegador). Las funciones de `functions/` corren **en el servidor
(edge)**, con IP real y sin CORS. El navegador solo habla con nuestra propia API
`/api/movies/*`.

## Estructura

```
index.html                       # la app (UI)
robots.txt / og.png / og.svg     # SEO: robots + imagen para compartir (y su fuente)
functions/api/movies/search.js   # GET /api/movies/search?q=<título>
functions/api/movies/ratings.js  # GET /api/movies/ratings?imdb=tt…&title=…&year=…
functions/api/movies/_lib.js     # scrapers + normalización + media + slugs
functions/pelicula/[slug].js     # GET /pelicula/<título>-<año>-<ttID>: ficha SSR
functions/c/[list].js            # GET /c/<slug>,<slug>: comparación compartible
functions/sitemap.xml.js         # GET /sitemap.xml (portada + fichas visitadas)
```

Cada fuente se consulta en su propio `try/catch` con timeout: si una cae o
cambia su HTML, simplemente desaparece de la media, no rompe la respuesta.

## SEO

- **Ficha por título** (`/pelicula/origen-2010-tt1375666`): HTML renderizado en
  el edge con OG/Twitter propios (el enlace muestra póster y nota al
  compartirse) y JSON-LD `Movie`/`TVSeries` con `AggregateRating` — lo que
  Google usa para pintar estrellas en sus resultados. Redirige 301 al slug
  canónico y se cachea 24 h en el edge.
- **Comparaciones compartibles** (`/c/slug,slug`): sirven la SPA con el `<head>`
  reescrito ("X vs Y — ¿cuál ver?"); el cliente carga esas películas al abrir.
  `noindex` para no diluir el SEO con combinaciones infinitas.
- **`sitemap.xml`**: portada + todas las fichas visitadas. Para que recuerde las
  fichas necesita un KV: crea un namespace y vincúlalo al proyecto de Pages como
  **`CINERANK_KV`** (Settings → Functions → KV namespace bindings). Sin KV el
  sitemap lista solo la portada; las fichas se descubren igualmente por los
  enlaces internos.

## Fuentes

| Fuente | Cómo | API key |
|--------|------|---------|
| **IMDb** | JSON-LD de la ficha (nota + género, duración, sinopsis, director, póster). Si IMDb sirve su challenge anti-bot, reintenta vía Browser Rendering y, si no, usa la nota de OMDb. | — (opcional `CF_*` / `OMDB_API_KEY`) |
| **Rotten Tomatoes** | Página de búsqueda (`search-page-media-row`) → ficha (`media-scorecard-json`) → Tomatómetro + Popcornmeter. | — |
| **FilmAffinity** | Scraping de la ficha (no hay API); si devuelve 403, reintenta vía Browser Rendering. | — (opcional `CF_*`) |
| **Metacritic** | Vía OMDb. | `OMDB_API_KEY` |
| **TMDb** | Endpoint `find` → nota de la comunidad + metadatos. | `TMDB_API_KEY` |

Funciona **sin ninguna clave** (Rotten Tomatoes al menos). Añadir las claves
desbloquea Metacritic/TMDb, hace IMDb robusto (respaldo OMDb), y con las
credenciales `CF_*` de Browser Rendering se recuperan IMDb y FilmAffinity
cuando bloquean el fetch directo desde el edge.

### Browser Rendering (opcional, recomendado)

IMDb y FilmAffinity bloquean peticiones simples desde IPs de datacenter.
[Browser Rendering](https://developers.cloudflare.com/browser-rendering/) las
carga en un navegador real de Cloudflare (hay tier gratuito). Configúralo con
dos variables en el proyecto de Pages:

- `CF_ACCOUNT_ID` → Dashboard → Workers & Pages (está en la barra lateral).
- `CF_API_TOKEN` → Dashboard → My Profile → API Tokens → *Create Token* con el
  permiso **Browser Rendering: Edit**.

## Desplegar en Cloudflare Pages

### Opción A — Conectar el repo (recomendado, auto-deploy en cada push)

1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Elige este repositorio (`dogcalas/cinerank`).
3. Build settings:
   - **Framework preset:** `None`
   - **Build command:** *(vacío)*
   - **Build output directory:** `/`
4. **Save and Deploy**. Cloudflare detecta la carpeta `functions/` y publica las
   rutas `/api/movies/*` automáticamente.
5. (Opcional) **Settings → Variables and Secrets** → añade `OMDB_API_KEY`,
   `TMDB_API_KEY`, `CF_ACCOUNT_ID` y/o `CF_API_TOKEN`. No hace falta cambiar
   código.

### Opción B — CLI con Wrangler

```bash
npm i -g wrangler
wrangler login
wrangler pages deploy . --project-name cinerank
# claves opcionales:
wrangler pages secret put OMDB_API_KEY --project-name cinerank
wrangler pages secret put TMDB_API_KEY --project-name cinerank
```

## Claves opcionales (gratis)

- `OMDB_API_KEY` → https://www.omdbapi.com/apikey.aspx (añade Metacritic).
- `TMDB_API_KEY` → https://www.themoviedb.org/settings/api (añade la nota TMDb).

## Desarrollo local

```bash
npx wrangler pages dev .
# abre http://localhost:8788
```

---

Las notas pertenecen a sus respectivas plataformas; esta app solo las agrega
para uso personal.
