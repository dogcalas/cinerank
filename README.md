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
functions/api/movies/search.js   # GET /api/movies/search?q=<título>
functions/api/movies/ratings.js  # GET /api/movies/ratings?imdb=tt…&title=…&year=…
functions/api/movies/_lib.js     # scrapers + normalización + media
```

Cada fuente se consulta en su propio `try/catch` con timeout: si una cae o
cambia su HTML, simplemente desaparece de la media, no rompe la respuesta.

## Fuentes

| Fuente | Cómo | API key |
|--------|------|---------|
| **IMDb** | JSON-LD de la ficha (nota + género, duración, sinopsis, director, póster). | — |
| **Rotten Tomatoes** | Endpoint público `napi/search` → Tomatómetro + audiencia. | — |
| **FilmAffinity** | Scraping de la ficha (no hay API). | — |
| **Metacritic** | Vía OMDb. | `OMDB_API_KEY` |
| **TMDb** | Endpoint `find` → nota de la comunidad + metadatos. | `TMDB_API_KEY` |

Funciona **sin ninguna clave** (IMDb + Rotten Tomatoes + FilmAffinity). Añadir
las claves desbloquea Metacritic/TMDb y hace IMDb/RT más robustos.

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
5. (Opcional) **Settings → Variables and Secrets** → añade `OMDB_API_KEY` y/o
   `TMDB_API_KEY`. No hace falta cambiar código.

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
