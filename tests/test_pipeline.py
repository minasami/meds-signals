import numpy as np
import pandas as pd
import pytest
from pipeline.aggregate import aggregate
from pipeline.detect import detect, _calc_causal_z, _build_wide
from synth.generate import build_events
from env.make_synthetic_env import generate as gen_env
from eval.backtest import evaluate

def test_small_cell_suppression():
    df = pd.DataFrame([{"date": "2026-01-01", "inn": "x", "therapeutic_class": "c", "governorate": "Cairo",
                        "event_type": "catalog_search", "count": 9}])
    out = aggregate(df, k=10)
    assert bool(out.iloc[0]["suppressed"])
    assert pd.isna(out.iloc[0]["count"])

def test_single_weak_signal_rejected():
    """A single non-extreme demand blip without supply or climate support must NOT alert."""
    rows = []
    env = []
    dates = pd.date_range("2026-01-01", periods=30)
    for i, d in enumerate(dates):
        # Moderate search increase on final day (count 35 vs 20 base, z ~ 3.0), normal unavailable (2, suppressed)
        search_count = 20 if i < 29 else 35
        for typ, val in [("catalog_search", search_count), ("quote_request", 15),
                        ("quote_unavailable", 2), ("alt_search_after_unavailable", 1)]:
            rows.append({"date": d.date().isoformat(), "inn": "testinn", "therapeutic_class": "antihypertensives",
                         "governorate": "Cairo", "event_type": typ, "count": val, "suppressed": False})
        env.append({"date": d.date().isoformat(), "governorate": "Cairo", "tmax_c": 30, "pm25_ugm3": 20})
    alerts = detect(pd.DataFrame(rows), pd.DataFrame(env), min_history=14)
    # Must NOT produce any alert
    assert len(alerts) == 0

def test_env_only_never_alerts():
    """An environmental anomaly without abnormal demand or supply friction must NOT alert."""
    rows = []
    env = []
    dates = pd.date_range("2026-01-01", periods=30)
    for i, d in enumerate(dates):
        for typ, val in [("catalog_search", 20), ("quote_request", 15),
                        ("quote_unavailable", 2), ("alt_search_after_unavailable", 1)]:
            rows.append({"date": d.date().isoformat(), "inn": "oral_rehydration_salts",
                         "therapeutic_class": "antidiarrhoeals_ors", "governorate": "Cairo",
                         "event_type": typ, "count": val, "suppressed": False})
        # Heatwave +15C on last 5 days, but demand and supply remain completely normal
        t = 30 if i < 25 else 45
        env.append({"date": d.date().isoformat(), "governorate": "Cairo", "tmax_c": t, "pm25_ugm3": 20})
    alerts = detect(pd.DataFrame(rows), pd.DataFrame(env), min_history=14)
    assert len(alerts) == 0

def test_demand_only_never_alerts():
    """Extreme search spike (10x, z > 15) without supply or climate support must NOT alert."""
    rows = []
    env = []
    dates = pd.date_range("2026-01-01", periods=30)
    for i, d in enumerate(dates):
        for typ, val in [("catalog_search", 20 if i < 29 else 200), ("quote_request", 15),
                        ("quote_unavailable", 2 if i < 29 else 2), ("alt_search_after_unavailable", 1)]:
            rows.append({"date": d.date().isoformat(), "inn": "testinn", "therapeutic_class": "testclass",
                         "governorate": "Cairo", "event_type": typ, "count": val, "suppressed": False})
        env.append({"date": d.date().isoformat(), "governorate": "Cairo", "tmax_c": 30, "pm25_ugm3": 20})
    alerts = detect(pd.DataFrame(rows), pd.DataFrame(env), min_history=14)
    # Demand alone must NEVER alert, whatever its magnitude
    assert len(alerts) == 0

def test_missing_data_stays_nan_and_preserves_baseline():
    """Missing days stay NaN in detect wide table and do not lower trailing baselines."""
    dates = pd.date_range("2026-01-01", periods=25)
    rows = []
    env = []
    for i, d in enumerate(dates):
        # Day 10 is explicitly missing
        is_missing = (i == 10)
        cnt = np.nan if is_missing else 20
        status = "missing" if is_missing else "observed"
        rows.append({
            "date": d.date().isoformat(), "inn": "testinn", "therapeutic_class": "antihypertensives",
            "governorate": "Cairo", "event_type": "catalog_search", "count": cnt,
            "suppressed": False, "data_status": status
        })
        rows.append({
            "date": d.date().isoformat(), "inn": "testinn", "therapeutic_class": "antihypertensives",
            "governorate": "Cairo", "event_type": "quote_request", "count": 15,
            "suppressed": False, "data_status": "observed"
        })
        env.append({"date": d.date().isoformat(), "governorate": "Cairo", "tmax_c": 30, "pm25_ugm3": 20})

    agg_df = pd.DataFrame(rows)
    env_df = pd.DataFrame(env)

    # Exercise the real detector pivot: missing rows must stay NaN, not become 0.0
    wide = _build_wide(agg_df)
    wide["date"] = wide["date"].dt.date.astype(str)
    all_days = pd.MultiIndex.from_product(
        [[d.date().isoformat() for d in dates], ["testinn"], ["antihypertensives"], ["Cairo"]],
        names=["date", "inn", "therapeutic_class", "governorate"]
    ).to_frame().reset_index(drop=True)
    wide = pd.merge(all_days, wide, on=["date", "inn", "therapeutic_class", "governorate"], how="left")
    assert (wide["catalog_search"].fillna(-1) != 0).all(), "No observed or missing day may be pivoted to 0.0"

    day_10_search = wide.loc[wide["date"] == dates[10].date().isoformat(), "catalog_search"].values[0]
    assert pd.isna(day_10_search), f"Missing day catalog_search should be NaN, got {day_10_search}"

    # Verify detect() runs and does not emit alerts
    alerts = detect(agg_df, env_df, min_history=14)
    assert len(alerts) == 0

    # Verify baseline with missing observation (NaN) is 20.0, whereas if it were 0.0, baseline is pulled down
    causal_z, baselines = _calc_causal_z(wide["catalog_search"], pd.to_datetime(wide["date"]), min_history=14)
    assert np.isclose(baselines[20], 20.0), f"Expected trailing baseline 20.0, got {baselines[20]}"

def test_detector_emits_explainable_fused_shortage():
    """Co-occurring search rise and unsuppressed supply friction produces possible_shortage with full metadata."""
    rows = []
    env = []
    dates = pd.date_range("2026-01-01", periods=35)
    for i, d in enumerate(dates):
        for typ, val in [("catalog_search", 20 if i < 28 else 80), ("quote_request", 20),
                        ("quote_unavailable", 2 if i < 28 else 18), ("alt_search_after_unavailable", 1)]:
            rows.append({"date": d.date().isoformat(), "inn": "amlodipine", "therapeutic_class": "antihypertensives",
                         "governorate": "Alexandria", "event_type": typ, "count": val, "suppressed": False})
        env.append({"date": d.date().isoformat(), "governorate": "Alexandria", "tmax_c": 30, "pm25_ugm3": 20})
    alerts = detect(pd.DataFrame(rows), pd.DataFrame(env), min_history=14)
    # Must NOT pass vacuously
    assert len(alerts) > 0
    assert all("disclaimer" in a and "contributing_signals" in a and "assumptions" in a for a in alerts)
    assert all(a["type"] == "possible_shortage" for a in alerts)
    # Check that merged assumptions list all contributing signals
    assert any("supply_friction" in a["assumptions"] for a in alerts)

def test_past_only_baseline_no_lookahead():
    """Truncating future data must not change baseline or z-scores for past/current day t."""
    dates = pd.date_range("2026-01-01", periods=50, freq="D")
    rng = np.random.default_rng(12345)
    counts = pd.Series([20 + (i % 7) * 2 + int(rng.poisson(3)) for i in range(50)])

    # Compute z with 35 days vs full 50 days
    t = 34  # 35th day (0-indexed)
    z_full, base_full = _calc_causal_z(counts, pd.Series(dates), min_history=14)
    z_trunc, base_trunc = _calc_causal_z(counts.iloc[:t+1], pd.Series(dates[:t+1]), min_history=14)

    assert not np.isnan(z_full[t])
    assert not np.isnan(z_trunc[t])
    assert np.isclose(z_full[t], z_trunc[t], atol=1e-10)
    assert np.isclose(base_full[t], base_trunc[t], atol=1e-10)

def test_end_to_end_fixture_default_seed(tmp_path):
    """End-to-end evaluation on the default seed: shortage & heatwave detected, media spike ignored."""
    ev = build_events(seed=20261018)
    tmp_env = tmp_path / "environment.csv"
    env = gen_env(path=tmp_env, seed=20261018)
    agg = aggregate(ev)
    alerts = detect(agg, env)

    assert len(alerts) > 0, "Detection must not emit 0 alerts on the benchmark fixture"

    # 1. Shortage detected for amlodipine in Alexandria and Dakahlia
    shortage_alerts = [a for a in alerts if a["inn"] == "amlodipine" and a["type"] == "possible_shortage"]
    govs_shortage = {a["governorate"] for a in shortage_alerts}
    assert "Alexandria" in govs_shortage
    assert "Dakahlia" in govs_shortage

    # 2. Heatwave detected for antidiarrhoeals_ors
    heat_alerts = [a for a in alerts if a["therapeutic_class"] == "antidiarrhoeals_ors"]
    assert len(heat_alerts) >= 20, f"Expected >= 20 heatwave series alerts, got {len(heat_alerts)}"

    # 3. Media false spike NOT alerted
    media_alerts = [
        a for a in alerts
        if a["inn"] == "cetirizine"
        and a["start_date"] <= "2026-08-08"
        and a["end_date"] >= "2026-08-05"
    ]
    assert len(media_alerts) == 0, f"Media false spike should not alert, but got {len(media_alerts)} alerts"

    # 4. Missing data does NOT cause confident alerts on absent dates
    missing_dates = {"2026-07-17", "2026-08-02", "2026-09-04"}
    missing_govs = {"Assiut", "Qalyubia"}
    missing_alerts = [
        a for a in alerts
        if a["governorate"] in missing_govs and a["start_date"] in missing_dates
    ]
    assert len(missing_alerts) == 0, f"Missing data dates must not emit alerts, got {len(missing_alerts)}"

def test_backtest_evaluates_expected_types_and_negative_controls():
    """Backtest accurately penalizes wrong alert types and media spike alerts as false alarms."""
    scenarios = {
        "date_start": "2026-07-01", "date_end": "2026-09-28",
        "scenarios": [
            {"id": "S1", "label": "supply_shortage", "inn": "amlodipine", "governorates": ["Alexandria"],
             "start": "2026-08-12", "end": "2026-08-23", "expected_type": "possible_shortage"},
            {"id": "S3", "label": "media_false_spike", "inn": "cetirizine", "governorates": ["Cairo"],
             "start": "2026-08-05", "end": "2026-08-08", "expected_type": "unusual_demand"}
        ]
    }
    # Alert with WRONG expected_type (unusual_demand instead of possible_shortage)
    wrong_type_alerts = [{
        "id": "1", "type": "unusual_demand", "inn": "amlodipine", "governorate": "Alexandria",
        "start_date": "2026-08-14", "end_date": "2026-08-20", "contributing_signals": []
    }]
    res = evaluate(wrong_type_alerts, scenarios)
    assert res["scenario_sensitivity"] == 0.0
    assert res["alert_level_ppv_proxy"] == 0.0
    assert res["false_alarm_count"] == 1

    # Media alert counts as false alarm
    media_alerts = [{
        "id": "2", "type": "unusual_demand", "inn": "cetirizine", "governorate": "Cairo",
        "start_date": "2026-08-06", "end_date": "2026-08-07", "contributing_signals": []
    }]
    res_media = evaluate(media_alerts, scenarios)
    assert res_media["media_spike_alerts_count"] == 1
    assert res_media["alert_level_ppv_proxy"] == 0.0
    assert res_media["false_alarm_count"] == 1
