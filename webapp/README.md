# meds-signals web app (v2)

Live: https://meds-signals.vercel.app — early signal, not diagnosis.

Static site (no framework). Upload aggregated pharmacy-sales, environment and workplace CSV/JSON; parsed in the browser, never stored. Robust z-score vs 28-day day-of-week baseline, plain-language EN/AR alert and prevention cards, Leaflet governorate map (bundled geoBoundaries ADM1, © OpenStreetMap contributors, ODbL).

- `public/` — app (`index.html`, `app.js`, `analysis.js`), SAMPLE (synthetic) files in `public/samples/`
- `api/explain.mjs` — optional LLM explanation, enabled only if `AI_GATEWAY_API_KEY` is already set (not set)
- `npm run build` — runs `scripts/check.cjs` (detection checks on SAMPLE data)
- `scripts/make_samples.py` — regenerates SAMPLE files (fixed seed)

All data in this folder is SAMPLE / synthetic. No real patient, prescription, pharmacy or employer data.
