"""Final model: fit on the whole history and write service artifacts plus the submission file.

    python -m pipeline.forecast

Outputs (ml/artifacts): forecast_hourly.csv, calendar.csv, weather_daily.csv, events.csv,
factors.json, metrics.json; submission/submission.csv in the organizers' format.
"""
import json

import numpy as np
import pandas as pd

from . import external
from .data import ARTIFACTS, ML, load_inputs
from .model import FEATURES, Forecaster

AS_OF = "2025-10-31"
FORECAST_FROM, FORECAST_TO = "2025-11-01", "2026-10-31"
SUBMISSION_TO = "2025-12-31"
# level of November and December against the latest clean October weeks
SEASON = {11: 1.0, 12: 1.0}


def month_index(hourly, days):
    """2025 midweek level of each month relative to October (whole network, weather removed)."""
    d = hourly.groupby("date").boardings.sum()
    k = days.reindex(d.index)
    mid = d[k.kind == "mid"]
    lvl = mid.groupby(mid.index.month).median()
    return (lvl / lvl[10]).to_dict()


def model_card(model, months):
    """Everything the fitted model learned, in plain JSON."""
    def keyed(series_or_dict):
        items = series_or_dict.items()
        return {f"{r}/{k}": (round(float(v), 1) if np.ndim(v) == 0 else [round(float(x), 5) for x in v]) for (r, k), v in items}
    return {
        "trained_until": AS_OF,
        "coefficients": {k: round(float(v), 5) for k, v in model.beta.items()},
        "base_daily_boardings": keyed(model.base),
        "base_during_events": keyed(model.base_event),
        "weekday_ratio_after_events": {f"{r}/{k}": round(float(v), 4) for (r, k), v in model.restore_ratio.items() if np.isfinite(v)},
        "hourly_profiles": keyed(model.profiles),
        "month_factor": {str(k): round(float(v), 4) for k, v in months.items()},
        "special_days": model.special_days,
        "new_routes": model.new_routes,
    }


def event_effects(hourly, events):
    """Measured effect of each disruption: median day during it / median same weekday in the 4 weeks before."""
    daily = hourly.groupby(["route", "date"]).boardings.sum()
    out = []
    for e in events.itertuples():
        if e.kind not in ("closure", "shortened", "reroute") or e.route not in daily.index.get_level_values(0):
            out.append(1.0)
            continue
        d = daily.loc[e.route]
        weekend = d.index.dayofweek >= 5
        sel = {"weekend": weekend, "workday": ~weekend}.get(e.days, np.ones(len(d), bool))
        during = d[sel & (d.index >= e.date_from) & (d.index <= e.date_to)]
        before = d[sel & (d.index < e.date_from) & (d.index >= e.date_from - pd.Timedelta(weeks=4))]
        ok = len(during) and len(before) and before.median() > 0
        out.append(round(float(during.median() / before.median()), 3) if ok else 1.0)
    return out


def main():
    hourly, days, events, sources = load_inputs()
    idx = month_index(hourly, days)
    months = {m: v for m, v in idx.items() if m <= 10}
    months.update(SEASON)
    model = Forecaster(month_factor=months).fit(hourly, days, events, AS_OF)
    dates = pd.date_range(FORECAST_FROM, FORECAST_TO)
    pred = model.predict(dates)

    bt_path = ARTIFACTS / "backtest.json"
    bt = json.loads(bt_path.read_text(encoding="utf-8")) if bt_path.exists() else {}
    q = bt.get("daily_ratio_quantiles", {"p10": 0.9, "p90": 1.1})
    pred["p10"] = (pred.p50 * min(q["p10"], 1.0)).round(1)
    pred["p90"] = (pred.p50 * max(q["p90"], 1.0)).round(1)
    pred["p50"] = pred.p50.round(1)
    pred["date"] = pred.date.dt.strftime("%Y-%m-%d")
    pred[["route", "date", "hour", "p10", "p50", "p90"]].sort_values(["route", "date", "hour"]).to_csv(
        ARTIFACTS / "forecast_hourly.csv", index=False)

    sub = pred[pred.date <= SUBMISSION_TO][["route", "date", "hour", "p50"]].rename(columns={"p50": "prediction"})
    sub["prediction"] = sub.prediction.round().clip(lower=0).astype(int)
    sub = sub.sort_values(["route", "date", "hour"])
    assert len(sub) == 10 * 61 * 24 and sub.prediction.notna().all()
    out = ML.parent / "submission"
    out.mkdir(exist_ok=True)
    sub.to_csv(out / "submission.csv", sep=";", index=False)

    cal = days.reset_index()[["date", "kind", "hol", "pre", "school"]]
    cal = cal[(cal.date >= "2025-01-01") & (cal.date <= "2026-12-31")]
    kind = cal.kind.map({"hol": "holiday", "sat": "saturday", "sun": "sunday"}).fillna("workday")
    notes = external.load_calendar().set_index("date").note.reindex(cal.date).fillna("").values
    pd.DataFrame({"date": cal.date.dt.strftime("%Y-%m-%d"), "day_type": kind,
                  "is_holiday": (kind == "holiday").astype(int) | days.reindex(cal.date).hol_we.values,
                  "is_preholiday": cal.pre.values, "school_break": cal.school.values | days.reindex(cal.date).school.values,
                  "note": notes}).to_csv(ARTIFACTS / "calendar.csv", index=False)

    wx = external.weather_for(pd.date_range("2025-01-01", FORECAST_TO))
    pd.DataFrame({"date": wx.index.strftime("%Y-%m-%d"), "t_mean": wx.t_mean.round(1), "precip_mm": wx.precip_mm.round(1),
                  "snow_cm": wx.snow_cm.round(1), "source": wx.source}).to_csv(ARTIFACTS / "weather_daily.csv", index=False)

    ev = external.load_events()
    ev_out = ev.assign(factor=event_effects(hourly, ev),
                       date_from=ev.date_from.dt.strftime("%Y-%m-%d"), date_to=ev.date_to.dt.strftime("%Y-%m-%d"))
    ev_out[["route", "date_from", "date_to", "days", "factor", "title", "source_url"]].to_csv(ARTIFACTS / "events.csv", index=False)

    b = model.beta
    factors = {
        "weather": {"cold_coef": round(b["cold"], 5), "heat_coef": round(b["heat"], 5),
                    "precip_coef": round((b["rain_warm"] + b["rain_we"]) / 2, 5), "snow_coef": round(b["snow"], 5)},
        "formula": "m = exp(cold_coef*max(-temp_delta,0) + heat_coef*max(temp_delta,0) + precip_coef*ln(1+precip_mm) + snow_coef*ln(1+snow_cm)) * (1+event_pct/100) * (1+season_pct/100)",
        "limits": {"temp_delta": [-15, 15], "precip_mm": [0, 30], "snow_cm": [0, 30], "event_pct": [-100, 100], "season_pct": [-30, 30]},
        "presets": [
            {"id": "snowfall", "title": "Сильный снегопад", "temp_delta": -5, "precip_mm": 0, "snow_cm": 10, "event_pct": 0, "season_pct": 0},
            {"id": "rain", "title": "Затяжной дождь", "temp_delta": 0, "precip_mm": 12, "snow_cm": 0, "event_pct": 0, "season_pct": 0},
            {"id": "frost", "title": "Сильный мороз", "temp_delta": -15, "precip_mm": 0, "snow_cm": 0, "event_pct": 0, "season_pct": 0},
            {"id": "closure", "title": "Закрытие участка", "temp_delta": 0, "precip_mm": 0, "snow_cm": 0, "event_pct": -60, "season_pct": 0},
            {"id": "event", "title": "Массовое мероприятие", "temp_delta": 0, "precip_mm": 0, "snow_cm": 0, "event_pct": 25, "season_pct": 0},
            {"id": "summer", "title": "Летний спад", "temp_delta": 0, "precip_mm": 0, "snow_cm": 0, "event_pct": 0, "season_pct": -20},
        ],
        "note": "Коэффициенты взяты из той же регрессии, что строит прогноз уровня дня: это оценка по истории 2025 года, а не допущение.",
    }
    (ARTIFACTS / "factors.json").write_text(json.dumps(factors, ensure_ascii=False, indent=1), encoding="utf-8")

    metrics = {
        "model": {
            "name": "Уровень дня x профиль часа",
            "description": "Дневной уровень маршрута берётся из последних чистых недель без влияния погоды, "
                           "поправки на календарь, погоду и ремонты даёт гребневая регрессия (scikit-learn) с ограничением знаков, "
                           "распределение по часам - средний профиль последних 4 недель для своего типа дня.",
            "features": FEATURES,
            "coefficients": {k: round(float(v), 4) for k, v in b.items()},
            "month_factor": {str(k): round(float(v), 3) for k, v in months.items()},
            "special_days": model.special_days,
            "trained_until": AS_OF,
        },
        "backtests": bt.get("backtests", []),
        "by_route": bt.get("by_route", []),
        "external_effects": bt.get("external_effects", []),
        "intervals": {"p10_ratio": round(q["p10"], 3), "p90_ratio": round(q["p90"], 3),
                      "note": "p10 и p90 - квантили отношения факт/прогноз дневной суммы маршрута на исторических окнах"},
    }
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=1), encoding="utf-8")
    (ARTIFACTS / "model.json").write_text(json.dumps(model_card(model, months), ensure_ascii=False), encoding="utf-8")
    print("submission rows", len(sub), "total", int(sub.prediction.sum()))
    print("coefficients", metrics["model"]["coefficients"])


if __name__ == "__main__":
    main()
