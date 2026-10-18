# Synthetic backtest report

**Scope:** deterministic synthetic data only; not a real-world performance estimate.

## Default run metrics (Seed 20261018)
- Alerts emitted: 32
- Scenario sensitivity (shortage + heatwave): 100.0%
- Series sensitivity (shortage + heatwave): 100.0%
  - Shortage series: 2/2
  - Heatwave series: 30/30
- Alert-level PPV proxy: 100.0%
- False alarms per 30 days (proxy): 0.00
- Media-spike alerts (negative control): 0
- Missing-data alerts (negative control): 0
- Missing-data behaviour: Explicitly flagged missing rows are evaluated without emitting false alarms from absent observations.

## Scenario checks (Default seed)

| Scenario | Detected | Matched alerts | Expected type | Observed types | Lead time (days) |
|---|---:|---:|---|---|---:|
| supply_shortage | yes | 2 | possible_shortage | possible_shortage | 0 |
| heatwave_ors_demand | yes | 30 | unusual_demand | unusual_demand | 0 |
| media_false_spike | no | 0 | none (negative control) | none | n/a |
| missing_data | no | 0 | none (negative control) | none | n/a |

## Tuning seeds robustness (5 seeds: 20261018, 1, 42, 7777, 99999)

- Mean scenario sensitivity: 100.0% (min: 100.0%)
- Mean series sensitivity: 99.4% (min: 96.9%)
  - Mean shortage series recall: 100.0% (min: 100.0%)
  - Mean heatwave series recall: 99.3% (min: 96.7%)
- Mean PPV proxy: 100.0% (min: 100.0%)
- Mean false alarms / 30d: 0.00 (max: 0.00)
- Total media-spike false alarms: 0
- Total missing-data false alarms: 0

| Seed | Total alerts | Shortage series | Heatwave series | Media alerts | PPV proxy | False alarms / 30d |
|---|---:|---:|---:|---:|---:|---:|
| 20261018 | 32 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 1 | 33 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 42 | 32 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 7777 | 31 | 2/2 | 29/30 | 0 | 100.0% | 0.00 |
| 99999 | 33 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |

## Hold-out seeds robustness (5 seeds: 2, 3, 5, 8, 13)

- Mean scenario sensitivity: 100.0% (min: 100.0%)
- Mean series sensitivity: 100.0% (min: 100.0%)
  - Mean shortage series recall: 100.0% (min: 100.0%)
  - Mean heatwave series recall: 100.0% (min: 100.0%)
- Mean PPV proxy: 98.9% (min: 97.2%)
- Mean false alarms / 30d: 0.13 (max: 0.33)
- Total media-spike false alarms: 0
- Total missing-data false alarms: 0

| Seed | Total alerts | Shortage series | Heatwave series | Media alerts | PPV proxy | False alarms / 30d |
|---|---:|---:|---:|---:|---:|---:|
| 2 | 35 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 3 | 34 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 5 | 38 | 2/2 | 30/30 | 0 | 97.4% | 0.33 |
| 8 | 33 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 13 | 36 | 2/2 | 30/30 | 0 | 97.2% | 0.33 |

## Combined 10-seed robustness summary (10 seeds: 20261018, 1, 42, 7777, 99999, 2, 3, 5, 8, 13)

- Mean scenario sensitivity: 100.0% (min: 100.0%)
- Mean series sensitivity: 99.7% (min: 96.9%)
  - Mean shortage series recall: 100.0% (min: 100.0%)
  - Mean heatwave series recall: 99.7% (min: 96.7%)
- Mean PPV proxy: 99.5% (min: 97.2%)
- Mean false alarms / 30d: 0.07 (max: 0.33)
- Total media-spike false alarms: 0
- Total missing-data false alarms: 0

| Seed | Total alerts | Shortage series | Heatwave series | Media alerts | PPV proxy | False alarms / 30d |
|---|---:|---:|---:|---:|---:|---:|
| 20261018 | 32 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 1 | 33 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 42 | 32 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 7777 | 31 | 2/2 | 29/30 | 0 | 100.0% | 0.00 |
| 99999 | 33 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 2 | 35 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 3 | 34 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 5 | 38 | 2/2 | 30/30 | 0 | 97.4% | 0.33 |
| 8 | 33 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 13 | 36 | 2/2 | 30/30 | 0 | 97.2% | 0.33 |

## Fresh untouched hold-out (evaluated once, after tuning was frozen) (10 seeds: 100, 101, 102, 103, 104, 105, 106, 107, 108, 109)

- Mean scenario sensitivity: 100.0% (min: 100.0%)
- Mean series sensitivity: 99.4% (min: 96.9%)
  - Mean shortage series recall: 100.0% (min: 100.0%)
  - Mean heatwave series recall: 99.3% (min: 96.7%)
- Mean PPV proxy: 99.4% (min: 97.0%)
- Mean false alarms / 30d: 0.07 (max: 0.33)
- Total media-spike false alarms: 0
- Total missing-data false alarms: 0

| Seed | Total alerts | Shortage series | Heatwave series | Media alerts | PPV proxy | False alarms / 30d |
|---|---:|---:|---:|---:|---:|---:|
| 100 | 35 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 101 | 33 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 102 | 34 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 103 | 35 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 104 | 33 | 2/2 | 29/30 | 0 | 97.0% | 0.33 |
| 105 | 35 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 106 | 34 | 2/2 | 29/30 | 0 | 100.0% | 0.00 |
| 107 | 34 | 2/2 | 30/30 | 0 | 97.1% | 0.33 |
| 108 | 34 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |
| 109 | 35 | 2/2 | 30/30 | 0 | 100.0% | 0.00 |

## Interpretation

These results describe synthetic scenario evaluations under controlled perturbations. Lead time reflects detection delay (0 days indicates detection on scenario day 1; this is not predictive lead time ahead of onset). Multi-seed backtesting across tuning and hold-out seeds evaluates detection consistency across randomized demand and unavailability trajectories under past-only causal baselines.
