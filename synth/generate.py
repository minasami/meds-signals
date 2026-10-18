"""Deterministic, entirely synthetic aggregate event generator."""
from pathlib import Path
import argparse
import json
import numpy as np
import pandas as pd

SEED = 20261018
GOVERNORATES = ["Cairo", "Giza", "Alexandria", "Qalyubia", "Dakahlia", "Assiut"]
CLASSES = {
    "antipyretics": ["paracetamol", "ibuprofen", "acetaminophen_combo", "metamizole", "aspirin"],
    "antidiarrhoeals_ors": ["oral_rehydration_salts", "zinc_sulfate", "racecadotril", "loperamide", "probiotic_mix"],
    "respiratory": ["salbutamol", "budesonide", "cetirizine", "loratadine", "guaifenesin",
                    "ambroxol", "montelukast", "ipratropium", "beclometasone", "dextromethorphan"],
    "antibiotics": ["amoxicillin", "azithromycin", "cefuroxime", "cefixime", "doxycycline",
                    "ciprofloxacin", "metronidazole", "flucloxacillin", "cephalexin", "clarithromycin"],
    "antihypertensives": ["amlodipine", "losartan", "valsartan", "bisoprolol", "ramipril",
                         "enalapril", "indapamide", "hydrochlorothiazide", "candesartan", "lisinopril"],
    "antidiabetics": ["metformin", "gliclazide", "sitagliptin", "empagliflozin", "insulin_glargine",
                      "insulin_regular", "glimepiride", "dapagliflozin", "pioglitazone", "linagliptin"]
}
DATES = pd.date_range("2026-07-01", periods=90, freq="D")

def build_events(out_dir=None, seed=SEED):
    rng = np.random.default_rng(seed)
    records = []
    for day_i, date in enumerate(DATES):
        dow_factor = [0.86, 0.91, 0.96, 1.00, 1.08, 1.18, 1.10][date.dayofweek]
        trend = 1 + 0.0018 * day_i
        for cls, inns in CLASSES.items():
            for inn in inns:
                for gov_i, gov in enumerate(GOVERNORATES):
                    base = 15 + (sum(map(ord, inn)) % 11) + gov_i * 2
                    seasonal = dow_factor * trend
                    demand = max(3, int(rng.poisson(base * seasonal)))
                    # Heatwave aligned to synthetic environment: 20-26 August.
                    if cls == "antidiarrhoeals_ors" and pd.Timestamp("2026-08-20") <= date <= pd.Timestamp("2026-08-26"):
                        demand = int(demand * (2.2 if gov in ("Cairo", "Giza", "Qalyubia") else 1.8))
                    # Media false spike: search interest rises, but no availability friction.
                    if inn == "cetirizine" and pd.Timestamp("2026-08-05") <= date <= pd.Timestamp("2026-08-08"):
                        demand = int(demand * 3.0)
                    unavailable_rate = 0.045 + 0.012 * (gov_i % 2)
                    # Supply disruption for one INN in exactly two governorates.
                    shortage_window = pd.Timestamp("2026-08-12") <= date <= pd.Timestamp("2026-08-23")
                    if inn == "amlodipine" and gov in ("Alexandria", "Dakahlia") and shortage_window:
                        unavailable_rate = 0.66
                        demand = int(demand * 1.22)
                    unavailable = int(rng.binomial(demand, min(unavailable_rate, .9)))
                    quote = max(0, int(rng.poisson(demand * 0.52)))
                    alt_search = int(rng.binomial(unavailable, .58))
                    # Some dates are intentionally incomplete at governorate level.
                    missing_day = date in [pd.Timestamp("2026-07-17"), pd.Timestamp("2026-08-02"),
                                           pd.Timestamp("2026-09-04")]
                    if missing_day and gov in ("Assiut", "Qalyubia"):
                        for event_type in [
                            "catalog_search", "quote_request",
                            "quote_unavailable", "alt_search_after_unavailable"
                        ]:
                            records.append({
                                "date": date.date().isoformat(), "inn": inn, "therapeutic_class": cls,
                                "governorate": gov, "event_type": event_type, "count": None,
                                "data_status": "missing"
                            })
                        continue
                    for event_type, count in [
                        ("catalog_search", demand), ("quote_request", quote),
                        ("quote_unavailable", unavailable),
                        ("alt_search_after_unavailable", alt_search)
                    ]:
                        records.append({"date": date.date().isoformat(), "inn": inn, "therapeutic_class": cls,
                                        "governorate": gov, "event_type": event_type, "count": count,
                                        "data_status": "observed_synthetic"})
    df = pd.DataFrame(records)
    if out_dir:
        out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
        df.to_csv(out / "events.csv", index=False)
        scenarios = {
          "synthetic_only": True, "seed": seed, "date_start": str(DATES.min().date()),
          "date_end": str(DATES.max().date()),
          "scenarios": [
            {"id":"S1","label":"supply_shortage","inn":"amlodipine","governorates":["Alexandria","Dakahlia"],
             "start":"2026-08-12","end":"2026-08-23","expected_type":"possible_shortage"},
            {"id":"S2","label":"heatwave_ors_demand","therapeutic_class":"antidiarrhoeals_ors",
             "governorates":["Cairo","Giza","Alexandria","Qalyubia","Dakahlia","Assiut"],
             "start":"2026-08-20","end":"2026-08-26","expected_type":"unusual_demand"},
            {"id":"S3","label":"media_false_spike","inn":"cetirizine","governorates":GOVERNORATES,
             "start":"2026-08-05","end":"2026-08-08","expected_type":"unusual_demand",
             "note":"Search volume rises while synthetic unavailability remains at normal levels."},
            {"id":"S4","label":"missing_data","dates":["2026-07-17","2026-08-02","2026-09-04"],
             "governorates":["Assiut","Qalyubia"],"expected_behavior":"avoid confident alerts from absent observations"}
          ],
          "method_note":"All records and scenario labels are fabricated for demonstration; not operational evidence."
        }
        (out / "scenarios.json").write_text(json.dumps(scenarios, indent=2))
    return df

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Deterministic synthetic aggregate event generator.")
    ap.add_argument("--seed", type=int, default=SEED, help="Random seed for generation")
    ap.add_argument("--out-dir", type=str, default=None, help="Output directory (default: <root>/data)")
    args = ap.parse_args()
    root = Path(__file__).resolve().parents[1]
    out_dir = args.out_dir or str(root / "data")
    build_events(out_dir, seed=args.seed)
