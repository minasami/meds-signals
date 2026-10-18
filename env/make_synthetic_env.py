import argparse
from pathlib import Path
import numpy as np
import pandas as pd

GOVS = {"Cairo": (35, 0.8), "Giza": (36, 0.7), "Alexandria": (31, 0.5),
        "Qalyubia": (35, 0.8), "Dakahlia": (34, 0.9), "Assiut": (38, 1.0)}

def generate(path=None, seed=20261018):
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2026-07-01", periods=90)
    rows = []
    for gov, (base, noise) in GOVS.items():
        for d in dates:
            wave = 12 if pd.Timestamp("2026-08-20") <= d <= pd.Timestamp("2026-08-26") else 0
            t = base + 0.05 * (d.dayofyear - 182) + wave + rng.normal(0, noise)
            pm = max(4, rng.normal(22 if gov != "Cairo" else 31, 6))
            rows.append({"date": d.date().isoformat(), "governorate": gov, "tmax_c": round(t, 1),
                         "pm25_ugm3": round(pm, 1), "source": "synthetic_demo", "synthetic": True})
    df = pd.DataFrame(rows)
    target = Path(path or Path(__file__).with_name("environment.csv"))
    target.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(target, index=False)
    return df

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Synthetic environment generator.")
    ap.add_argument("--seed", type=int, default=20261018, help="Random seed")
    ap.add_argument("--output", type=str, default=None, help="Output CSV path")
    args = ap.parse_args()
    generate(args.output, seed=args.seed)
