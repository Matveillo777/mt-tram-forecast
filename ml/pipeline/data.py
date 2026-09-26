"""Inputs shared by backtests and the final forecast."""
from pathlib import Path

import pandas as pd

from . import external
from .model import day_table

ML = Path(__file__).resolve().parents[1]
ARTIFACTS = ML / "artifacts"
MODEL_EVENTS = {"closure", "shortened", "reroute"}


def load_inputs(start="2025-01-01", end="2026-12-31"):
    hourly = pd.read_csv(ARTIFACTS / "history_hourly.csv", parse_dates=["date"])
    dates = pd.date_range(start, end)
    days = day_table(dates, external.load_calendar(start, end), external.weather_for(dates))
    ev = external.load_events()
    events = ev[ev.kind.isin(MODEL_EVENTS)].copy()
    sources = {
        "Погода (Open-Meteo)": {"url": external.WEATHER_URL,
                                "note": "дневные осадки, снег, жара и холод; осадки считаются за 7-21 ч"},
        "Календарь и каникулы": {"url": "https://www.consultant.ru/law/ref/calendar/proizvodstvennye/2025/",
                                 "note": "праздники, переносы, предпраздничные дни, школьные каникулы Москвы"},
        "Ремонты и перекрытия (новости)": {"url": ", ".join(sorted(set(events.source_url.dropna()))),
                                           "note": "закрытия и укорочения маршрутов по новостям Мосгортранса и СМИ"},
    }
    return hourly, days, events, sources
