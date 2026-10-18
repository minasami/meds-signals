"""Aggregate event counts; suppress cells below k=10 and never emit person-level data."""
from pathlib import Path
import pandas as pd

K = 10
KEYS = ["date", "inn", "therapeutic_class", "governorate"]
PROHIBITED_KEYWORDS = {
    "user", "patient", "prescription", "phone", "email", "person",
    "national_id", "mobile", "name", "address", "ssn", "civil_id", "identifier"
}

def aggregate(events: pd.DataFrame, k=K):
    required = set(KEYS + ["event_type", "count"])
    if not required.issubset(events.columns):
        raise ValueError(f"Missing columns: {required - set(events.columns)}")
    for c in events.columns:
        c_lower = c.lower()
        if any(kw in c_lower for kw in PROHIBITED_KEYWORDS):
            raise ValueError(f"Individual-level identifiers are prohibited (detected column: {c}).")

    has_status = "data_status" in events.columns
    agg_funcs = {"count": lambda s: s.sum(min_count=1)}
    if has_status:
        agg_funcs["data_status"] = "first"

    grouped = events.groupby(KEYS + ["event_type"], as_index=False).agg(agg_funcs)

    is_missing = grouped["data_status"].eq("missing") if has_status else pd.Series(False, index=grouped.index)
    grouped.loc[(~is_missing) & (grouped["count"] < k), "count"] = pd.NA
    grouped["suppressed"] = (~is_missing) & grouped["count"].isna()
    return grouped

def run(input_path=None, output_path=None):
    root = Path(__file__).resolve().parents[1]
    inp = Path(input_path or root / "data/events.csv")
    out = Path(output_path or root / "data/aggregated.csv")
    df = aggregate(pd.read_csv(inp))
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    rel_out = out.relative_to(root) if out.is_relative_to(root) else out
    print(f"Aggregated {len(df)} rows; suppressed {int(df.suppressed.sum())} small cells; wrote {rel_out}")
    return df

if __name__ == "__main__":
    run()
