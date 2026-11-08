# meds-signals web app (v2)

Live: https://meds-signals.vercel.app — early signal, not diagnosis.

Static site (no framework). Upload aggregated pharmacy-sales, environment and workplace CSV/JSON; parsed in the browser, never stored. Robust z-score vs 28-day day-of-week baseline, plain-language EN/AR alert and prevention cards, Leaflet governorate map (bundled geoBoundaries ADM1, © OpenStreetMap contributors, ODbL).

- `public/` — app (`index.html`, `app.js`, `analysis.js`), SAMPLE (synthetic) files in `public/samples/`
- `api/explain.mjs` — optional LLM explanation via Vercel AI Gateway (AI SDK `generateText`). Each request builds its own gateway from the `x-vercel-oidc-token` header, then `@vercel/oidc` `getVercelOidcToken()`, then an unexpired `VERCEL_OIDC_TOKEN` for local dev, so AI Gateway credits work without an API key. `AI_GATEWAY_API_KEY` is an optional override. Optional `EXPLAIN_MODEL` (default `openai/gpt-4o-mini`). Without a token or key, `GET /api/explain` returns `{enabled:false}` and the AI box stays hidden.
- Detection: robust z-score (28-day, day-of-week) confirmed by a plain-JS Isolation Forest (`MS.isolationForest`); `analyse(series, {mode:"z"})` reproduces z-only.
- `/samples/` — SAMPLE file index; `/?samples=1` (or `&lang=ar`) loads all SAMPLE data in one click
- `npm run build` — runs `scripts/check.cjs` (detection checks on SAMPLE data)
- `scripts/make_samples.py` — regenerates SAMPLE files (fixed seed)

All data in this folder is SAMPLE / synthetic. No real patient, prescription, pharmacy or employer data.
