"""Inputs shared by backtests and the final forecast."""
from pathlib import Path

import pandas as pd

from . import external
from .model import day_table

ML = Path(__file__).resolve().parents[1]
ARTIFACTS = ML / "artifacts"
MODEL_EVENTS = {"closure", "shortened", "reroute", "anomaly"}


def load_inputs(start="2025-01-01", end="2026-12-31"):
    hourly = pd.read_csv(ARTIFACTS / "history_hourly.csv", parse_dates=["date"])
    dates = pd.date_range(start, end)
    days = day_table(dates, external.load_calendar(start, end), external.weather_for(dates))
    ev = external.load_events()
    ev["published"] = pd.to_datetime(ev.published)
    events = ev[ev.kind.isin(MODEL_EVENTS)].copy()
    sources = {
        "Погода (Open-Meteo)": {"url": external.WEATHER_URL,
                                "note": "дневные осадки, снег, жара и холод; осадки считаются за 7-21 ч"},
        "Календарь и каникулы": {"url": "https://www.consultant.ru/law/ref/calendar/proizvodstvennye/2025/",
                                 "note": "праздники, переносы, предпраздничные дни, школьные каникулы Москвы"},
        "Ремонты и изменения маршрутов (новости)": {"url": "https://www.mskagency.ru/materials/3506273",
                                                    "note": "закрытия, укорочения и объединения маршрутов по новостям; учитываются только новости, вышедшие до начала окна"},
        "Очистка аномалий в данных": {"url": "",
                                      "note": "дни с провалом посадок, найденные в самих данных (маршрут 17, апрель 2025), не попадают в базу прогноза"},
    }
    return hourly, days, events, sources


def honest_inputs(days, events, origin, start="2025-01-01", end="2026-12-31"):
    """What was really known on the origin date: observed weather only up to it, climate after it,
    news published up to it, data anomalies only for days already seen."""
    o = pd.Timestamp(origin)
    dates = pd.date_range(start, end)
    weather = external.weather_for(dates)
    clim = external.climate_for(dates)
    weather.loc[weather.index > o] = clim.loc[clim.index > o, weather.columns]
    days_known = day_table(dates, external.load_calendar(start, end), weather)
    news = events[(events.kind != "anomaly") & (events.published <= o)]
    seen = events[(events.kind == "anomaly") & (events.date_from <= o)].copy()
    seen["date_to"] = seen.date_to.clip(upper=o)
    return days_known, pd.concat([news, seen])

