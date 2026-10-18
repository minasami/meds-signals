from pathlib import Path
import json
import pandas as pd
import plotly.express as px
import streamlit as st

import sys
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

st.set_page_config(page_title="MedS Hub Medicine Signals", layout="wide")
st.title("MedS Hub Medicine Signals")
st.caption("Synthetic demonstration only • aggregate early-warning signals • not a diagnosis")

# Guard: auto-generate pipeline outputs if running from a clean clone
agg_path = ROOT / "data/aggregated.csv"
alerts_path = ROOT / "data/alerts.json"
env_path = ROOT / "env/environment.csv"
if not agg_path.exists() or not alerts_path.exists() or not env_path.exists():
    with st.spinner("Generating demonstration data for default seed..."):
        import synth.generate
        import env.make_synthetic_env
        import pipeline.aggregate
        import pipeline.detect
        synth.generate.build_events(str(ROOT / "data"))
        env.make_synthetic_env.generate(str(ROOT / "env/environment.csv"))
        pipeline.aggregate.run()
        pipeline.detect.run()

alerts = json.loads(alerts_path.read_text()) if alerts_path.exists() else []
events = pd.read_csv(agg_path)
env = pd.read_csv(env_path)
events["date"] = pd.to_datetime(events.date)
env["date"] = pd.to_datetime(env.date)

if not env.empty and env["synthetic"].astype(str).str.lower().eq("true").any():
    st.warning("Environmental series is synthetic and labelled as such. This dashboard is not operational surveillance.")

with st.sidebar:
    st.header("Filters")
    govs = sorted(events.governorate.unique())
    gov = st.selectbox("Governorate", ["All"] + govs)
    classes = sorted(events.therapeutic_class.unique())
    cls = st.selectbox("Therapeutic class", ["All"] + classes)

filtered = events.copy()
if gov != "All":
    filtered = filtered[filtered.governorate == gov]
if cls != "All":
    filtered = filtered[filtered.therapeutic_class == cls]

c1, c2, c3 = st.columns(3)
c1.metric("Synthetic alert records", len(alerts))
c2.metric("Governorates", events.governorate.nunique())
c3.metric("INNs represented", events.inn.nunique())

st.subheader("Governorate signal overview")
searches_only = filtered[(filtered.event_type == "catalog_search") & (~filtered.suppressed.astype(bool))]
overview_searches = searches_only.groupby("governorate", as_index=False)["count"].sum().rename(
    columns={"count": "catalog_searches (unsuppressed lower bound)"}
)
overview_cells = filtered[~filtered.suppressed.astype(bool)].groupby("governorate", as_index=False)["count"].count().rename(
    columns={"count": "unsuppressed_cells"}
)
overview = overview_searches.merge(overview_cells, on="governorate", how="outer").fillna(0)
overview["unsuppressed_cells"] = overview["unsuppressed_cells"].astype(int)
overview["catalog_searches (unsuppressed lower bound)"] = overview["catalog_searches (unsuppressed lower bound)"].astype(int)

st.dataframe(overview, width="stretch", hide_index=True)

# Coordinates are approximate governorate reference points for visual orientation only.
coords = {"Cairo": (30.0444, 31.2357), "Giza": (30.0131, 31.2089), "Alexandria": (31.2001, 29.9187),
          "Qalyubia": (30.3292, 31.2165), "Dakahlia": (31.0364, 31.3807), "Assiut": (27.1809, 31.1837)}
if not overview.empty:
    overview["lat"] = overview.governorate.map(lambda x: coords[x][0])
    overview["lon"] = overview.governorate.map(lambda x: coords[x][1])
    st.map(overview, latitude="lat", longitude="lon", size="unsuppressed_cells")

st.subheader("Aggregate time series")
metric = st.selectbox("Event type", ["catalog_search", "quote_request", "quote_unavailable", "alt_search_after_unavailable"])
series = filtered[(filtered.event_type == metric) & (~filtered.suppressed.astype(bool))]
if not series.empty:
    ts = series.groupby(["date", "governorate"], as_index=False)["count"].sum()
    fig = px.line(ts, x="date", y="count", color="governorate", title=metric.replace("_", " ").title())
    for a in alerts:
        if (gov == "All" or a["governorate"] == gov) and (cls == "All" or a["therapeutic_class"] == cls):
            fig.add_vline(x=a["start_date"], line_dash="dot", opacity=.35)
    st.plotly_chart(fig, width="stretch")

st.subheader("Environmental overlay")
env_f = env if gov == "All" else env[env.governorate == gov]
if not env_f.empty:
    efig = px.line(env_f, x="date", y="tmax_c", color="governorate", title="Daily maximum temperature (°C)")
    st.plotly_chart(efig, width="stretch")
    st.caption("PM2.5 is shown as a daily mean where available; units: µg/m³.")
    st.dataframe(env_f[["date", "governorate", "tmax_c", "pm25_ugm3", "source", "synthetic"]], width="stretch", hide_index=True)

st.subheader("Alert cards")
matching = [a for a in alerts if (gov == "All" or a["governorate"] == gov) and (cls == "All" or a["therapeutic_class"] == cls)]
if not matching:
    st.info("No alerts for the current filter in the current synthetic run.")
for a in matching[:100]:
    with st.expander(f"{a['type']} · {a['inn']} · {a['governorate']} · {a['start_date']}"):
        st.write(f"**Window:** {a['start_date']} to {a['end_date']}")
        st.write(f"**Signals:** {a['contributing_signals']}")
        st.write(f"**Assumptions:** {a['assumptions']}")
        st.write(f"**Suggested operational follow-up:** {a['recommended_action']}")
        st.write(f"**Responsible role:** {a['responsible_role']}")
        st.warning(a["disclaimer"])

st.subheader("Pharmacy referral panel")
st.caption("MOCK participating pharmacies — fictional examples for UI testing only; not real providers.")
st.dataframe(pd.DataFrame([
    {"Mock pharmacy": "MOCK Cairo Pharmacy 01", "Governorate": "Cairo", "Status": "Mock participant", "Contact": "Not provided"},
    {"Mock pharmacy": "MOCK Giza Pharmacy 02", "Governorate": "Giza", "Status": "Mock participant", "Contact": "Not provided"},
    {"Mock pharmacy": "MOCK Alexandria Pharmacy 03", "Governorate": "Alexandria", "Status": "Mock participant", "Contact": "Not provided"},
    {"Mock pharmacy": "MOCK Assiut Pharmacy 04", "Governorate": "Assiut", "Status": "Mock participant", "Contact": "Not provided"}
]), width="stretch", hide_index=True)
