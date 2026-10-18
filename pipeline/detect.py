"""Explainable aggregate anomaly detector; not a diagnosis or clinical decision system."""
from pathlib import Path
import json
import numpy as np
import pandas as pd

# Climate-sensitive therapeutic classes: environmental anomalies only support these classes
CLIMATE_SENSITIVE = {
    "temperature": {"antidiarrhoeals_ors"},
    "pm25": {"respiratory"},
}

def _calc_causal_z(series: pd.Series, dates: pd.Series, min_history=14, window=28):
    """Compute causal past-only weekday-adjusted residual z-scores with no future lookahead.

    For each day t:
    - baseline: median of same-weekday counts in trailing past window [t-window, t-1] (min 2 occurrences).
      Falls back to trailing median if < 2 same weekdays, or expanding past median.
    - past residuals: past counts minus trailing base.
    - mad: median absolute deviation of past residuals in [t-window, t-1] * 1.4826 (min 2.0).
    - z: (series[t] - baseline[t]) / mad.
    """
    # Implemented on NumPy arrays for speed; semantics are identical to the original
    # pandas loop (verified bit-for-bit on randomised series with gaps).
    vals = pd.to_numeric(pd.Series(series), errors="coerce").to_numpy(dtype=float)
    dows = pd.to_datetime(pd.Series(dates)).dt.dayofweek.to_numpy()
    n = len(vals)
    z_scores = np.full(n, np.nan)
    baselines = np.full(n, np.nan)
    notna = ~np.isnan(vals)

    for i in range(min_history, n):
        w_start = max(0, i - window)
        mask = notna[w_start:i]
        v_win_s = vals[w_start:i][mask]
        v_win_d = dows[w_start:i][mask]

        if len(v_win_s) < 3:
            v_past = vals[:i][notna[:i]]
            if len(v_past) < 3:
                continue
            base = float(np.median(v_past))
        else:
            same_dow = v_win_s[v_win_d == dows[i]]
            if len(same_dow) >= 2:
                base = float(np.median(same_dow))
            elif len(v_win_s) >= 7:
                base = float(np.median(v_win_s))
            else:
                base = float(np.median(vals[:i][notna[:i]]))

        baselines[i] = base
        past_res = np.abs(v_win_s - base)
        mad = float(np.median(past_res) * 1.4826) if len(past_res) > 0 else 2.0
        mad = max(mad, 2.0)

        if notna[i]:
            z_scores[i] = (vals[i] - base) / mad

    return z_scores, baselines

def _finalize_alert(alert: dict) -> None:
    signal_names = ", ".join(s["type"] for s in alert["contributing_signals"]) or "single extreme signal"
    escalation_note = ""
    if alert.get("type_escalated"):
        escalation_note = (
            f" Note: episode onset was causally typed as '{alert.get('initial_type')}' on {alert['start_date']}; "
            f"it was upgraded to '{alert['type']}' after supply friction emerged on subsequent days within the episode window."
        )
    alert["assumptions"] = (
        f"Aggregate counts are synthetic; past-only trailing baseline and rolling trend approximate normal variation. "
        f"Signals observed: {signal_names}.{escalation_note}"
    )
    if alert["type"] == "possible_shortage":
        alert["responsible_role"] = "pharmacy-network supply lead"
    else:
        alert["responsible_role"] = "public-health surveillance officer"
    alert["id"] = f"{alert['inn']}-{alert['governorate']}-{alert['start_date']}-{alert['type']}".replace(" ", "-")

def _build_wide(aggregated: pd.DataFrame) -> pd.DataFrame:
    """Pivot unsuppressed, observed aggregate cells to one row per date/INN/class/governorate.

    Suppressed cells and explicitly missing rows (data_status == "missing") are dropped before the
    pivot, so they stay absent/NaN and never become 0.0 through the pivot's sum.
    """
    valid = aggregated[~aggregated["suppressed"].astype(bool)].copy()
    if "data_status" in valid.columns:
        valid = valid[valid["data_status"] != "missing"]
    valid["count"] = pd.to_numeric(valid["count"], errors="coerce")
    valid = valid.dropna(subset=["count"])
    wide = valid.pivot_table(index=["date", "inn", "therapeutic_class", "governorate"],
                             columns="event_type", values="count", aggfunc="sum").reset_index()
    for col in ["catalog_search", "quote_request", "quote_unavailable", "alt_search_after_unavailable"]:
        if col not in wide:
            wide[col] = np.nan
    wide["date"] = pd.to_datetime(wide.date)
    return wide

def detect(aggregated: pd.DataFrame, environment: pd.DataFrame, min_history=14):
    wide = _build_wide(aggregated)
    env = environment.copy()
    env["date"] = pd.to_datetime(env.date)
    wide = wide.merge(env[["date", "governorate", "tmax_c", "pm25_ugm3"]], on=["date", "governorate"], how="left")

    # Coarser aggregates for supply friction denominator (to clear k=10)
    nat_agg = wide.groupby(["date", "inn"])[["quote_request", "quote_unavailable"]].sum(min_count=1).reset_index()
    nat_agg.rename(columns={"quote_request": "nat_quote_req", "quote_unavailable": "nat_quote_unavail"}, inplace=True)
    wide = wide.merge(nat_agg, on=["date", "inn"], how="left")

    class_gov_agg = wide.groupby(["date", "therapeutic_class", "governorate"])[["quote_request", "quote_unavailable"]].sum(min_count=1).reset_index()
    class_gov_agg.rename(columns={"quote_request": "class_gov_quote_req", "quote_unavailable": "class_gov_quote_unavail"}, inplace=True)
    wide = wide.merge(class_gov_agg, on=["date", "therapeutic_class", "governorate"], how="left")

    min_date = wide["date"].min()
    max_date = wide["date"].max()
    all_dates = pd.date_range(min_date, max_date, freq="D") if pd.notna(min_date) else []

    alerts = []
    for (inn, cls, gov), grp in wide.groupby(["inn", "therapeutic_class", "governorate"]):
        # Calendar-day reindexing: ensure rolling windows are by calendar day, not row count
        if len(all_dates) > 0:
            grp = grp.set_index("date").reindex(all_dates).reset_index().rename(columns={"index": "date"})
            grp["inn"] = inn
            grp["therapeutic_class"] = cls
            grp["governorate"] = gov
        else:
            grp = grp.sort_values("date").reset_index(drop=True)

        if len(grp) < min_history:
            continue

        s = grp["catalog_search"]
        dates = grp["date"]
        t = grp["tmax_c"]
        pm = grp["pm25_ugm3"]

        # Causal past-only baseline for catalog_search
        z_scores, baselines = _calc_causal_z(s, dates, min_history=min_history)
        grp["catalog_search_z"] = z_scores

        # CUSUM accumulation on past-only z-scores
        z_array = np.nan_to_num(z_scores, nan=0.0)
        cusum = []
        running = 0.0
        for val in z_array:
            running = max(0.0, running + val - 0.8)
            cusum.append(running)
        grp["cusum"] = cusum

        n = len(grp)
        supply_hist = []
        for i in range(min_history, n):
            row = grp.iloc[i]
            # Evaluate demand independently on catalog_search; do not require quote_unavailable to be present
            if pd.isna(row["catalog_search"]):
                continue

            z_val = grp["catalog_search_z"].iloc[i]
            c_val = grp["cusum"].iloc[i]
            demand = bool((pd.notna(z_val) and z_val >= 2.8) or (c_val >= 6.0))

            # Supply friction: unavailable / quote_request
            local_unavail = row["quote_unavailable"] if pd.notna(row["quote_unavailable"]) else 0.0
            local_quote = row["quote_request"] if pd.notna(row["quote_request"]) else 0.0
            if local_quote >= 10:
                denom = local_quote
            elif pd.notna(row.get("nat_quote_req")) and row["nat_quote_req"] >= 10:
                denom = row["nat_quote_req"]
            elif pd.notna(row.get("class_gov_quote_req")) and row["class_gov_quote_req"] >= 10:
                denom = row["class_gov_quote_req"]
            else:
                denom = row["catalog_search"] if pd.notna(row["catalog_search"]) else 1.0

            unavailable_ratio = local_unavail / max(denom, 1.0)
            raw_supply = bool(local_unavail >= 10 and unavailable_ratio >= 0.25)
            # Supply friction must persist (also present on at least one of the previous 2 evaluated days)
            supply = raw_supply and any(supply_hist[-2:])
            supply_hist.append(raw_supply)

            # Environmental anomaly: only supports declared climate-sensitive classes
            t_base = t.iloc[max(0, i-21):i].median() if i >= 7 else np.nan
            t_delta = (t.iloc[i] - t_base) if pd.notna(t_base) and pd.notna(t.iloc[i]) else np.nan

            pm_base = pm.iloc[max(0, i-21):i].median() if i >= 7 else np.nan
            pm_delta = (pm.iloc[i] - pm_base) if pd.notna(pm_base) and pd.notna(pm.iloc[i]) else np.nan

            env_signal = False
            env_val = None
            env_unit = None
            if cls in CLIMATE_SENSITIVE["temperature"] and pd.notna(t_delta) and t_delta >= 6.0:
                env_signal = True
                env_val = round(float(t_delta), 1)
                env_unit = "temperature_delta_c"
            elif cls in CLIMATE_SENSITIVE["pm25"] and pd.notna(pm_delta) and pm_delta >= 25.0:
                env_signal = True
                env_val = round(float(pm_delta), 1)
                env_unit = "pm25_delta_ugm3"

            signals = []
            if demand:
                signals.append({"type": "demand", "value": round(float(z_val), 2), "unit": "residual_z"})
            if supply:
                signals.append({"type": "supply_friction", "value": round(float(unavailable_ratio), 3), "unit": "unavailable_ratio"})
            if env_signal:
                signals.append({"type": "environment", "value": env_val, "unit": env_unit})

            # Single extreme signal rule: keep only for demand/supply with high threshold
            extreme_demand = False  # Demand alone never alerts (needs supply or climate corroboration)
            extreme_supply = bool(local_unavail >= 10 and unavailable_ratio >= 0.55)
            extreme = extreme_demand or extreme_supply

            # Env alone never fires an alert
            if env_signal and not demand and not supply and not extreme:
                continue

            if len(signals) < 2 and not extreme:
                continue

            # Alert typing: supply friction present -> possible_shortage; demand-only -> unusual_demand
            alert_type = "possible_shortage" if supply or extreme_supply else "unusual_demand"
            date_str = dates.iloc[i].date().isoformat()
            signal_names = ", ".join(s["type"] for s in signals) or "single extreme signal"
            alert_id = f"{inn}-{gov}-{date_str}-{alert_type}".replace(" ", "-")
            alerts.append({
                "id": alert_id, "type": alert_type, "initial_type": alert_type, "type_history": [alert_type],
                "inn": inn, "therapeutic_class": cls, "governorate": gov,
                "start_date": date_str, "end_date": date_str, "contributing_signals": signals,
                "assumptions": f"Aggregate counts are synthetic; past-only trailing baseline and rolling trend approximate normal variation. Signals observed: {signal_names}.",
                "recommended_action": "Review aggregate signal quality and verify through authorized supply-chain or public-health channels; do not infer patient-level need.",
                "responsible_role": "pharmacy-network supply lead" if alert_type == "possible_shortage" else "public-health surveillance officer",
                "disclaimer": "Signal for investigation, not a diagnosis."
            })

    if not alerts:
        return []

    # Episode consolidation across consecutive days (allowing 2-day gap), grouped by INN and governorate.
    # An alert's initial type is decided causally up to that day; if supply friction appears
    # on subsequent days within the episode window, the episode label is escalated to possible_shortage
    # with initial_type and type_history preserved and documented.
    a = pd.DataFrame(alerts).sort_values("start_date")
    consolidated = []
    for (inn, cls, gov), g in a.groupby(["inn", "therapeutic_class", "governorate"], sort=False):
        g = g.sort_values("start_date")
        current = None
        for _, row in g.iterrows():
            d = pd.Timestamp(row.start_date)
            if current is not None and (d - pd.Timestamp(current["end_date"])).days <= 2:
                current["end_date"] = row.start_date
                if "type_history" not in current or not isinstance(current["type_history"], list):
                    current["type_history"] = [current.get("initial_type", current["type"])]
                if row.type not in current["type_history"]:
                    current["type_history"].append(row.type)
                if row.type == "possible_shortage" and current["type"] != "possible_shortage":
                    current["type"] = "possible_shortage"
                    current["type_escalated"] = True
                known_types = {s["type"] for s in current["contributing_signals"]}
                for s in row.contributing_signals:
                    if s["type"] not in known_types:
                        current["contributing_signals"].append(s)
                        known_types.add(s["type"])
            else:
                if current:
                    _finalize_alert(current)
                    consolidated.append(current)
                current = row.to_dict()
                if "type_history" not in current or not isinstance(current["type_history"], list):
                    current["type_history"] = [current.get("initial_type", current["type"])]
        if current:
            _finalize_alert(current)
            consolidated.append(current)

    return consolidated

def run():
    root = Path(__file__).resolve().parents[1]
    agg = pd.read_csv(root / "data/aggregated.csv")
    env = pd.read_csv(root / "env/environment.csv")
    alerts = detect(agg, env)
    (root / "data/alerts.json").write_text(json.dumps(alerts, indent=2, default=str))
    print(f"Detected {len(alerts)} consolidated alerts -> data/alerts.json")
    return alerts

if __name__ == "__main__":
    run()
