# MedS Hub Medicine Signals

A standalone Python 3.11 prototype for explainable early-warning signals from **synthetic aggregate medicine-interest events** in six Egyptian governorates. It is not connected to MedS Hub core or any production system.

## Safety and scope
- All pharmacy event data and cached environmental data in this demo are synthetic.
- No real users, prescriptions, pharmacies, or pharmacy transactions are included.
- This is a signal for investigation, not a diagnosis. It provides no clinical or substitution advice.
- Small aggregate cells below k=10 are suppressed. No individual-level data is accepted.
- The Open-Meteo fetcher is optional and writes public environmental observations to `env/environment_open_meteo.csv` by default, protecting the synthetic demo cache.

## Run in 3 commands
```bash
python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
make demo
streamlit run app/streamlit_app.py
```

Run fast demo pipeline: `make demo` (or `./run.sh demo`, runs in seconds).
Run multi-seed backtest: `make backtest` (or `./run.sh backtest`).
Run unit tests: `make test` (or `pytest -q`).
Run demo and tests: `make all`.

## Validated metrics (Multi-seed synthetic backtest)
Evaluated across 10 randomized synthetic seeds: 5 tuning seeds (`20261018`, `1`, `42`, `7777`, `99999`) and 5 hold-out seeds (`2`, `3`, `5`, `8`, `13`).

- **Scenario sensitivity**: 100.0% mean across all 10 seeds (100.0% min)
- **Series sensitivity**:
  - Tuning seeds (5 seeds): 99.4% mean (min: 96.9%, max: 100.0%)
  - Hold-out seeds (5 seeds): 100.0% mean (min: 100.0%, max: 100.0%)
  - Combined (10 seeds): 99.7% mean (min: 96.9%, max: 100.0%)
  - Shortage series recall: 100.0% (2/2 series across all 10 seeds)
  - Heatwave series recall: 99.7% mean (min: 96.7%)
- **Alert-level PPV proxy**:
  - Tuning seeds: 100.0% mean (min: 100.0%, max: 100.0%)
  - Hold-out seeds: 98.9% mean (min: 97.2%, max: 100.0%)
  - Combined (10 seeds): 99.5% mean (min: 97.2%, max: 100.0%)
- **False alarms per 30 days**:
  - Tuning seeds: 0.00 mean (max: 0.00)
  - Hold-out seeds: 0.13 mean (max: 0.33)
  - Combined (10 seeds): 0.07 mean (max: 0.33)
- **Negative controls**:
  - Media false spike (S3): 0 alerts across all 10 seeds (demand alone never alerts without supply or climate support)
  - Missing data dates (S4): 0 false alarms across all 10 seeds (missing observations remain NaN and do not trigger false alarms or distort baselines)
- **Lead time on synthetic scenarios**: 0 days (detection delay = 0: detected on scenario onset day 1; this is detection delay, not predictive lead time ahead of onset)

See `reports/metrics.json` and `reports/backtest.md` for full results.

## Contents
- `synth/`: deterministic event generator with `--seed` CLI and labelled scenarios
- `env/`: synthetic cached environmental series and Open-Meteo fetcher
- `pipeline/`: aggregation with k=10 privacy suppression, past-only causal anomaly detection and fusion
- `eval/`: honest multi-seed scenario backtest and metrics
- `app/`: Streamlit dashboard (offline-first, no telemetry)
- `docs/TECHNICAL.md`: technical methodology, architecture, and governance documentation

## Licence
MIT. See `LICENSE`.
