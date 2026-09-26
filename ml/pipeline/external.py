"""External factors: production calendar, school breaks, weather, service events."""
from pathlib import Path

import numpy as np
import pandas as pd

ML = Path(__file__).resolve().parents[1]
EXT = ML / "data" / "external"

WEATHER_URL = (
    "https://archive-api.open-meteo.com/v1/archive?latitude=55.7558&longitude=37.6173"
    "&start_date=2020-01-01&end_date=2025-12-31"
    "&daily=temperature_2m_mean,precipitation_sum,rain_sum,snowfall_sum,snow_depth_max"
    "&timezone=Europe%2FMoscow&format=csv"
)


def load_calendar(start="2025-01-01", end="2026-12-31") -> pd.DataFrame:
    """One row per date: day_type, holiday/preholiday/transfer flags, school break."""
    cal = pd.read_csv(EXT / "production_calendar.csv", parse_dates=["date"])
    cal = cal[(cal.date >= start) & (cal.date <= end)].copy()
    breaks = pd.read_csv(EXT / "school_breaks.csv", parse_dates=["date_from", "date_to"])
    # summer holidays are a season, not a break: they go into the month factor instead
    breaks = breaks[(breaks.date_to - breaks.date_from).dt.days <= 21]
    cal["school_break"] = 0
    for b in breaks.itertuples():
        cal.loc[(cal.date >= b.date_from) & (cal.date <= b.date_to), "school_break"] = 1
    return cal.reset_index(drop=True)


def load_weather() -> pd.DataFrame:
    """Daily Moscow weather (Open-Meteo archive). Downloads once, then uses the cached CSV."""
    path = EXT / "weather_daily_raw.csv"
    if not path.exists():
        import urllib.request
        urllib.request.urlretrieve(WEATHER_URL, path)
    w = pd.read_csv(path, skiprows=3)
    w.columns = ["date", "t_mean", "precip_mm", "rain_mm", "snow_cm", "snow_depth_m"]
    w["date"] = pd.to_datetime(w.date)
    return w


HOURLY_URL = (
    "https://archive-api.open-meteo.com/v1/archive?latitude=55.7558&longitude=37.6173"
    "&start_date=2025-01-01&end_date=2025-12-31"
    "&hourly=temperature_2m,precipitation,rain,snowfall,snow_depth,weather_code,wind_speed_10m"
    "&timezone=Europe%2FMoscow&format=csv"
)


def daytime_precip() -> pd.DataFrame:
    """Rain (mm) and snowfall (cm) between 7 and 21 h, from the hourly archive."""
    path = EXT / "weather_hourly_2025_raw.csv"
    if not path.exists():
        import urllib.request
        urllib.request.urlretrieve(HOURLY_URL, path)
    h = pd.read_csv(path, skiprows=3)
    h.columns = ["time", "t", "precip", "rain", "snowfall", "snow_depth", "code", "wind"]
    h["time"] = pd.to_datetime(h.time)
    h = h[(h.time.dt.hour >= 7) & (h.time.dt.hour <= 21)]
    return h.groupby(h.time.dt.normalize()).agg(rain_day=("rain", "sum"), snow_day=("snowfall", "sum"))


def weather_for(dates: pd.DatetimeIndex) -> pd.DataFrame:
    """Observed weather where the archive has it, otherwise the 2020-2024 day-of-year climate."""
    w = load_weather().set_index("date")
    clim = w[w.index.year < 2025].groupby(w[w.index.year < 2025].index.dayofyear).mean(numeric_only=True)
    out = pd.DataFrame(index=pd.DatetimeIndex(dates, name="date"))
    obs = w.reindex(out.index)
    fill = clim.reindex(out.index.dayofyear).set_index(out.index)
    out = obs.fillna(fill)
    out["source"] = np.where(obs.t_mean.notna(), "observed", "climate")
    day = daytime_precip().reindex(out.index)
    # outside the hourly archive: the average daytime share of daily precipitation
    out["rain_day"] = day.rain_day.fillna(out.rain_mm * 0.6)
    out["snow_day"] = day.snow_day.fillna(out.snow_cm * 0.6)
    return out


def climate_for(dates: pd.DatetimeIndex) -> pd.DataFrame:
    """Weather nobody knows in advance: the 2020-2024 average for the same day of the year."""
    w = load_weather().set_index("date")
    past = w[w.index.year < 2025]
    clim = past.groupby(past.index.dayofyear).mean(numeric_only=True)
    out = clim.reindex(pd.DatetimeIndex(dates).dayofyear).set_index(pd.DatetimeIndex(dates, name="date"))
    out["source"] = "climate"
    out["rain_day"] = out.rain_mm * 0.6
    out["snow_day"] = out.snow_cm * 0.6
    return out


def load_events() -> pd.DataFrame:
    ev = pd.read_csv(EXT / "events.csv", parse_dates=["date_from", "date_to"])
    return ev
