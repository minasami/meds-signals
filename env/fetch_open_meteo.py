"""Optional public-data fetcher. Cached demo remains synthetic and offline-first.

Usage: python env/fetch_open_meteo.py --start 2026-07-01 --end 2026-09-28
Open-Meteo historical weather and air-quality APIs may have coverage/latency limits.
Fetched observations are public environmental data, not pharmacy data.
"""
import argparse
from pathlib import Path
import pandas as pd
import requests

LOCATIONS = {
    "Cairo": (30.0444, 31.2357), "Giza": (30.0131, 31.2089),
    "Alexandria": (31.2001, 29.9187), "Qalyubia": (30.3292, 31.2165),
    "Dakahlia": (31.0364, 31.3807), "Assiut": (27.1809, 31.1837)
}

def fetch(start, end, output=None):
    rows = []
    for gov, (lat, lon) in LOCATIONS.items():
        weather_url = "https://archive-api.open-meteo.com/v1/archive"
        weather = requests.get(weather_url, params={"latitude":lat,"longitude":lon,
            "start_date":start,"end_date":end,"daily":"temperature_2m_max","timezone":"Africa/Cairo"}, timeout=45)
        weather.raise_for_status()
        wd = weather.json().get("daily", {})
        air_url = "https://air-quality-api.open-meteo.com/v1/air-quality"
        air = requests.get(air_url, params={"latitude":lat,"longitude":lon,"start_date":start,
            "end_date":end,"hourly":"pm2_5","timezone":"Africa/Cairo"}, timeout=45)
        air.raise_for_status()
        ad = air.json().get("hourly", {})
        pm = pd.DataFrame({"time":ad.get("time",[]),"pm25":ad.get("pm2_5",[])})
        if not pm.empty:
            pm["date"] = pd.to_datetime(pm["time"]).dt.date.astype(str)
            pm_daily = pm.groupby("date")["pm25"].mean()
        else:
            pm_daily = pd.Series(dtype=float)
        for d, t in zip(wd.get("time",[]), wd.get("temperature_2m_max",[])):
            rows.append({"date":d,"governorate":gov,"tmax_c":t,"pm25_ugm3":pm_daily.get(d),
                         "source":"open_meteo_public_api","synthetic":False})
    df = pd.DataFrame(rows)
    path = Path(output or Path(__file__).with_name("environment_open_meteo.csv"))
    df.to_csv(path, index=False)
    print(f"Wrote {len(df)} rows to {path}")
    return df

if __name__ == "__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--start",default="2026-07-01"); ap.add_argument("--end",default="2026-09-28")
    ap.add_argument("--output",default=None); args=ap.parse_args()
    fetch(args.start,args.end,args.output)
