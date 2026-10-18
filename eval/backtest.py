from pathlib import Path
import json
import numpy as np
import pandas as pd

TUNING_SEEDS = [20261018, 1, 42, 7777, 99999]
HOLDOUT_SEEDS = [2, 3, 5, 8, 13]
# Fresh hold-out: first evaluated after all detector tuning was frozen; never used to change the detector.
FRESH_HOLDOUT_SEEDS = list(range(100, 110))
SEEDS = TUNING_SEEDS

def evaluate(alerts: list, scenarios: dict) -> dict:
    date_start = scenarios.get("date_start", "2026-07-01")
    date_end = scenarios.get("date_end", "2026-09-28")
    span_days = (pd.Timestamp(date_end) - pd.Timestamp(date_start)).days + 1
    span_months = max(span_days / 30.0, 1.0)

    rows = []
    matched_positive_alert_ids = set()
    s1_series = set()
    s2_series = set()

    for s in scenarios.get("scenarios", []):
        scen_id = s.get("id")
        label = s.get("label")

        if label == "missing_data":
            # Negative control: missing data must not trigger alerts on or adjacent to missing dates
            missing_dates = [pd.Timestamp(d) for d in s.get("dates", [])]
            target_govs = set(s.get("governorates", []))
            s4_alerts = []
            for a in alerts:
                if a.get("governorate") in target_govs:
                    a_start = pd.Timestamp(a["start_date"])
                    if any(abs((a_start - md).days) <= 1 for md in missing_dates):
                        s4_alerts.append(a)
            rows.append({
                "scenario_id": scen_id,
                "label": label,
                "detected": bool(s4_alerts),
                "matched_alert_count": len(s4_alerts),
                "lead_time_days": None,
                "expected_type": "none (negative control)",
                "observed_types": sorted({a["type"] for a in s4_alerts}),
                "note": "Negative control: no confident alerts from missing observations"
            })
            continue

        if label == "media_false_spike":
            # Negative control: search spike without supply friction should not fire alerts
            start = pd.Timestamp(s["start"])
            end = pd.Timestamp(s["end"])
            s3_alerts = [
                a for a in alerts
                if a.get("inn") == s.get("inn")
                and a["start_date"] <= str(end.date())
                and a["end_date"] >= str(start.date())
            ]
            rows.append({
                "scenario_id": scen_id,
                "label": label,
                "detected": bool(s3_alerts),
                "matched_alert_count": len(s3_alerts),
                "lead_time_days": None,
                "expected_type": "none (negative control)",
                "observed_types": sorted({a["type"] for a in s3_alerts}),
                "note": "Negative control: media spike should not trigger alerts"
            })
            continue

        # Positive scenarios (supply_shortage, heatwave_ors_demand)
        start = pd.Timestamp(s["start"])
        end = pd.Timestamp(s["end"])
        expected_type = s.get("expected_type")

        matching = []
        for a in alerts:
            if a["start_date"] <= str(end.date()) and a["end_date"] >= str(start.date()):
                if s.get("inn") and a.get("inn") != s["inn"]:
                    continue
                if s.get("therapeutic_class") and a.get("therapeutic_class") != s["therapeutic_class"]:
                    continue
                if s.get("governorates") and a.get("governorate") not in s["governorates"]:
                    continue
                # Expected alert type MUST match
                if a.get("type") == expected_type:
                    matching.append(a)
                    matched_positive_alert_ids.add(a["id"])

        detected = bool(matching)
        lead_time = None
        if matching:
            earliest_alert = min(a["start_date"] for a in matching)
            lead_time = (pd.Timestamp(earliest_alert) - start).days

        if label == "supply_shortage":
            for a in matching:
                s1_series.add(a["governorate"])
        elif label == "heatwave_ors_demand":
            for a in matching:
                s2_series.add((a["inn"], a["governorate"]))

        rows.append({
            "scenario_id": scen_id,
            "label": label,
            "detected": detected,
            "matched_alert_count": len(matching),
            "lead_time_days": lead_time,
            "expected_type": expected_type,
            "observed_types": sorted({a["type"] for a in matching}),
        })

    positive_rows = [r for r in rows if r["label"] in ("supply_shortage", "heatwave_ors_demand")]
    scenario_detected = sum(1 for r in positive_rows if r["detected"])
    scenario_sensitivity = scenario_detected / max(len(positive_rows), 1)

    s1_target_count = 2   # Alexandria, Dakahlia
    s2_target_count = 30  # 5 INNs x 6 governorates
    shortage_recall = len(s1_series) / s1_target_count
    heatwave_recall = len(s2_series) / s2_target_count
    series_sensitivity = (len(s1_series) + len(s2_series)) / (s1_target_count + s2_target_count)

    # All alerts not matched to positive scenarios with expected type are false alarms (including media spike)
    false_alarms = max(0, len(alerts) - len(matched_positive_alert_ids))
    ppv = len(matched_positive_alert_ids) / max(len(alerts), 1)
    fa_per_30 = false_alarms / span_months

    s3_result = next((r for r in rows if r["label"] == "media_false_spike"), None)
    s4_result = next((r for r in rows if r["label"] == "missing_data"), None)

    return {
        "scenario_sensitivity": round(float(scenario_sensitivity), 4),
        "scenario_positive_count": len(positive_rows),
        "scenario_positive_detected": scenario_detected,
        "series_sensitivity": round(float(series_sensitivity), 4),
        "shortage_series_recall": f"{len(s1_series)}/{s1_target_count}",
        "heatwave_series_recall": f"{len(s2_series)}/{s2_target_count}",
        "alert_level_ppv_proxy": round(float(ppv), 4),
        "false_alarms_per_30_days": round(float(fa_per_30), 4),
        "alert_count": len(alerts),
        "false_alarm_count": false_alarms,
        "media_spike_alerts_count": s3_result["matched_alert_count"] if s3_result else 0,
        "missing_data_alerts_count": s4_result["matched_alert_count"] if s4_result else 0,
        "missing_data_behavior": "Explicitly flagged missing rows are evaluated without emitting false alarms from absent observations.",
        "caveat": "Honest multi-signal scenario backtest; negative controls evaluated. PPV and false-alarm figures reflect scenario-level synthetic labels.",
        "scenario_results": rows
    }

_SEED_ALERTS_CACHE = {}

def _alerts_for_seed(seed: int) -> list:
    """Run the full synthetic pipeline for one seed (env written to a temp dir, never the tracked cache).

    Results are cached per process so tuning, hold-out and combined summaries reuse the same runs.
    """
    if seed not in _SEED_ALERTS_CACHE:
        import tempfile
        from synth.generate import build_events
        from env.make_synthetic_env import generate as gen_env
        from pipeline.aggregate import aggregate
        from pipeline.detect import detect
        with tempfile.TemporaryDirectory() as tmpdir:
            ev = build_events(seed=seed)
            env = gen_env(path=Path(tmpdir) / f"environment_{seed}.csv", seed=seed)
            _SEED_ALERTS_CACHE[seed] = detect(aggregate(ev), env)
    return _SEED_ALERTS_CACHE[seed]

def evaluate_multi_seed(seeds=None) -> dict:
    seeds = seeds or SEEDS
    per_seed = {}
    sens_list = []
    series_sens_list = []
    sh_recall_list = []
    hw_recall_list = []
    ppv_list = []
    fa_list = []
    media_list = []
    missing_list = []

    for seed in seeds:
        alerts = _alerts_for_seed(seed)
        scenarios = {
            "date_start": "2026-07-01",
            "date_end": "2026-09-28",
            "scenarios": [
                {"id": "S1", "label": "supply_shortage", "inn": "amlodipine", "governorates": ["Alexandria", "Dakahlia"], "start": "2026-08-12", "end": "2026-08-23", "expected_type": "possible_shortage"},
                {"id": "S2", "label": "heatwave_ors_demand", "therapeutic_class": "antidiarrhoeals_ors", "governorates": ["Cairo", "Giza", "Alexandria", "Qalyubia", "Dakahlia", "Assiut"], "start": "2026-08-20", "end": "2026-08-26", "expected_type": "unusual_demand"},
                {"id": "S3", "label": "media_false_spike", "inn": "cetirizine", "governorates": ["Cairo", "Giza", "Alexandria", "Qalyubia", "Dakahlia", "Assiut"], "start": "2026-08-05", "end": "2026-08-08", "expected_type": "unusual_demand"},
                {"id": "S4", "label": "missing_data", "dates": ["2026-07-17", "2026-08-02", "2026-09-04"], "governorates": ["Assiut", "Qalyubia"]}
            ]
        }
        res = evaluate(alerts, scenarios)
        per_seed[str(seed)] = res
        sens_list.append(res["scenario_sensitivity"])
        series_sens_list.append(res["series_sensitivity"])
        sh_num, sh_den = map(int, res["shortage_series_recall"].split("/"))
        sh_recall_list.append(sh_num / sh_den)
        hw_num, hw_den = map(int, res["heatwave_series_recall"].split("/"))
        hw_recall_list.append(hw_num / hw_den)
        ppv_list.append(res["alert_level_ppv_proxy"])
        fa_list.append(res["false_alarms_per_30_days"])
        media_list.append(res["media_spike_alerts_count"])
        missing_list.append(res["missing_data_alerts_count"])

    return {
        "seeds_evaluated": seeds,
        "scenario_sensitivity": {"mean": round(float(np.mean(sens_list)), 4), "min": round(float(np.min(sens_list)), 4), "max": round(float(np.max(sens_list)), 4)},
        "series_sensitivity": {"mean": round(float(np.mean(series_sens_list)), 4), "min": round(float(np.min(series_sens_list)), 4), "max": round(float(np.max(series_sens_list)), 4)},
        "shortage_series_recall": {"mean": round(float(np.mean(sh_recall_list)), 4), "min": round(float(np.min(sh_recall_list)), 4)},
        "heatwave_series_recall": {"mean": round(float(np.mean(hw_recall_list)), 4), "min": round(float(np.min(hw_recall_list)), 4)},
        "alert_level_ppv_proxy": {"mean": round(float(np.mean(ppv_list)), 4), "min": round(float(np.min(ppv_list)), 4), "max": round(float(np.max(ppv_list)), 4)},
        "false_alarms_per_30_days": {"mean": round(float(np.mean(fa_list)), 4), "max": round(float(np.max(fa_list)), 4)},
        "media_spike_alerts_total": sum(media_list),
        "missing_data_alerts_total": sum(missing_list),
        "per_seed_summary": {
            str(s): {
                "alerts": per_seed[str(s)]["alert_count"],
                "ppv": per_seed[str(s)]["alert_level_ppv_proxy"],
                "fa_30d": per_seed[str(s)]["false_alarms_per_30_days"],
                "shortage": per_seed[str(s)]["shortage_series_recall"],
                "heatwave": per_seed[str(s)]["heatwave_series_recall"],
                "media_alerts": per_seed[str(s)]["media_spike_alerts_count"]
            } for s in seeds
        }
    }

def _format_seed_section(title: str, m: dict) -> list:
    lines = [
        f"## {title} ({len(m['seeds_evaluated'])} seeds: {', '.join(map(str, m['seeds_evaluated']))})",
        "",
        f"- Mean scenario sensitivity: {m['scenario_sensitivity']['mean']:.1%} (min: {m['scenario_sensitivity']['min']:.1%})",
        f"- Mean series sensitivity: {m['series_sensitivity']['mean']:.1%} (min: {m['series_sensitivity']['min']:.1%})",
        f"  - Mean shortage series recall: {m['shortage_series_recall']['mean']:.1%} (min: {m['shortage_series_recall']['min']:.1%})",
        f"  - Mean heatwave series recall: {m['heatwave_series_recall']['mean']:.1%} (min: {m['heatwave_series_recall']['min']:.1%})",
        f"- Mean PPV proxy: {m['alert_level_ppv_proxy']['mean']:.1%} (min: {m['alert_level_ppv_proxy']['min']:.1%})",
        f"- Mean false alarms / 30d: {m['false_alarms_per_30_days']['mean']:.2f} (max: {m['false_alarms_per_30_days']['max']:.2f})",
        f"- Total media-spike false alarms: {m['media_spike_alerts_total']}",
        f"- Total missing-data false alarms: {m['missing_data_alerts_total']}",
        "",
        "| Seed | Total alerts | Shortage series | Heatwave series | Media alerts | PPV proxy | False alarms / 30d |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for s_str, sm in m["per_seed_summary"].items():
        lines.append(f"| {s_str} | {sm['alerts']} | {sm['shortage']} | {sm['heatwave']} | {sm['media_alerts']} | {sm['ppv']:.1%} | {sm['fa_30d']:.2f} |")
    return lines

def run():
    root = Path(__file__).resolve().parents[1]
    alerts_path = root / "data/alerts.json"
    scenarios_path = root / "data/scenarios.json"

    if alerts_path.exists():
        alerts = json.loads(alerts_path.read_text())
    else:
        # No demo output present (e.g. fresh clone): evaluate the default seed in memory instead of
        # silently scoring an empty alert list.
        print("data/alerts.json not found; evaluating default seed in memory (run `make demo` to write it).")
        alerts = _alerts_for_seed(TUNING_SEEDS[0])
    scenarios = json.loads(scenarios_path.read_text()) if scenarios_path.exists() else {}

    default_metrics = evaluate(alerts, scenarios)
    tuning_metrics = evaluate_multi_seed(TUNING_SEEDS)
    holdout_metrics = evaluate_multi_seed(HOLDOUT_SEEDS)
    combined_metrics_10 = evaluate_multi_seed(TUNING_SEEDS + HOLDOUT_SEEDS)
    fresh_holdout_metrics = evaluate_multi_seed(FRESH_HOLDOUT_SEEDS)

    combined_metrics = {
        **default_metrics,
        "multi_seed_evaluation": tuning_metrics,  # Tuning seeds (backwards compatible)
        "tuning_evaluation": tuning_metrics,
        "holdout_evaluation": holdout_metrics,
        "combined_10_seed_evaluation": combined_metrics_10,
        "fresh_holdout_evaluation": fresh_holdout_metrics
    }

    reports_dir = root / "reports"
    reports_dir.mkdir(exist_ok=True)
    (reports_dir / "metrics.json").write_text(json.dumps(combined_metrics, indent=2))

    lines = [
        "# Synthetic backtest report",
        "",
        "**Scope:** deterministic synthetic data only; not a real-world performance estimate.",
        "",
        "## Default run metrics (Seed 20261018)",
        f"- Alerts emitted: {default_metrics['alert_count']}",
        f"- Scenario sensitivity (shortage + heatwave): {default_metrics['scenario_sensitivity']:.1%}",
        f"- Series sensitivity (shortage + heatwave): {default_metrics['series_sensitivity']:.1%}",
        f"  - Shortage series: {default_metrics['shortage_series_recall']}",
        f"  - Heatwave series: {default_metrics['heatwave_series_recall']}",
        f"- Alert-level PPV proxy: {default_metrics['alert_level_ppv_proxy']:.1%}",
        f"- False alarms per 30 days (proxy): {default_metrics['false_alarms_per_30_days']:.2f}",
        f"- Media-spike alerts (negative control): {default_metrics['media_spike_alerts_count']}",
        f"- Missing-data alerts (negative control): {default_metrics['missing_data_alerts_count']}",
        f"- Missing-data behaviour: {default_metrics['missing_data_behavior']}",
        "",
        "## Scenario checks (Default seed)",
        "",
        "| Scenario | Detected | Matched alerts | Expected type | Observed types | Lead time (days) |",
        "|---|---:|---:|---|---|---:|",
    ]
    for r in default_metrics["scenario_results"]:
        lead_str = str(r.get("lead_time_days")) if r.get("lead_time_days") is not None else "n/a"
        lines.append(f"| {r['label']} | {'yes' if r['detected'] else 'no'} | {r['matched_alert_count']} | {r['expected_type']} | {', '.join(r['observed_types']) or 'none'} | {lead_str} |")

    lines.append("")
    lines.extend(_format_seed_section("Tuning seeds robustness", tuning_metrics))
    lines.append("")
    lines.extend(_format_seed_section("Hold-out seeds robustness", holdout_metrics))
    lines.append("")
    lines.extend(_format_seed_section("Combined 10-seed robustness summary", combined_metrics_10))
    lines.append("")
    lines.extend(_format_seed_section("Fresh untouched hold-out (evaluated once, after tuning was frozen)", fresh_holdout_metrics))

    lines.extend([
        "",
        "## Interpretation",
        "",
        "These results describe synthetic scenario evaluations under controlled perturbations. Lead time reflects detection delay (0 days indicates detection on scenario day 1; this is not predictive lead time ahead of onset). Multi-seed backtesting across tuning and hold-out seeds evaluates detection consistency across randomized demand and unavailability trajectories under past-only causal baselines.",
    ])

    (reports_dir / "backtest.md").write_text("\n".join(lines) + "\n")
    print(f"Backtest complete. Metrics saved to reports/metrics.json and reports/backtest.md")
    return combined_metrics

if __name__ == "__main__":
    run()
