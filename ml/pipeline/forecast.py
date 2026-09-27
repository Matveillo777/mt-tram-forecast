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
LF = chr(10)  # unix line endings on every OS, like the organizers' sample file
# level of November and December against the latest clean October weeks
SEASON = {11: 1.0, 12: 1.0}


def month_index(model):
    """2025 midweek level of each month relative to October, summed over routes, repair days left out."""
    d = model.daily[(model.daily.kind == "mid") & (model.daily.event == 0) & (model.daily.route != 5)]
    med = d.groupby(["route", d.date.dt.month]).total.median().unstack()
    med = med.dropna()
    return (med.sum() / med[10].sum()).to_dict()


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


def event_effects(hourly, events, days):
    """Measured effect of each disruption: median day during it / median of the same days in the 4 weeks before.
    Launches and restorations have nothing to compare with and get 1."""
    daily = hourly.groupby(["route", "date"]).boardings.sum()
    out = []
    for e in events.itertuples():
        if e.kind not in ("closure", "shortened", "reroute", "anomaly") or e.route not in daily.index.get_level_values(0):
            out.append(1.0)
            continue
        d = daily.loc[e.route]
        off = days.offday.reindex(d.index).values == 1
        sel = {"weekend": off, "workday": ~off}.get(e.days, np.ones(len(d), bool))
        during = d[sel & (d.index >= e.date_from) & (d.index <= e.date_to)]
        before = d[sel & (d.index < e.date_from) & (d.index >= e.date_from - pd.Timedelta(weeks=4))]
        ok = len(during) and len(before) and before.median() > 0
        out.append(round(float(during.median() / before.median()), 3) if ok else 1.0)
    return out


def main():
    hourly, days, events, sources = load_inputs()
    model = Forecaster().fit(hourly, days, events, AS_OF)
    months = {m: v for m, v in month_index(model).items() if m <= 10}
    months.update(SEASON)
    model.month_factor = months
    dates = pd.date_range(FORECAST_FROM, FORECAST_TO)
    pred = model.predict(dates)

    bt_path = ARTIFACTS / "backtest.json"
    bt = json.loads(bt_path.read_text(encoding="utf-8")) if bt_path.exists() else {}
    q = bt.get("daily_ratio_quantiles", {"p10": 0.9, "p90": 1.1})
    pred["date"] = pred.date.dt.strftime("%Y-%m-%d")
    # the submission is rounded once from the exact p50, like in the backtests
    sub = pred[pred.date <= SUBMISSION_TO][["route", "date", "hour", "p50"]].rename(columns={"p50": "prediction"})
    sub["prediction"] = sub.prediction.round().clip(lower=0).astype(int)
    sub = sub.sort_values(["route", "date", "hour"])
    assert len(sub) == 10 * 61 * 24 and sub.prediction.notna().all()
    out = ML.parent / "submission"
    out.mkdir(exist_ok=True)
    sub.to_csv(out / "submission.csv", sep=";", index=False, lineterminator=LF)

    pred["p10"] = (pred.p50 * min(q["p10"], 1.0)).round(1)
    pred["p90"] = (pred.p50 * max(q["p90"], 1.0)).round(1)
    pred["p50"] = pred.p50.round(1)
    pred[["route", "date", "hour", "p10", "p50", "p90"]].sort_values(["route", "date", "hour"]).to_csv(
        ARTIFACTS / "forecast_hourly.csv", index=False, lineterminator=LF)

    cal = days.reset_index()[["date", "kind", "hol", "pre", "school"]]
    cal = cal[(cal.date >= "2025-01-01") & (cal.date <= "2026-12-31")]
    kind = cal.kind.map({"hol": "holiday", "sat": "saturday", "sun": "sunday"}).fillna("workday")
    notes = external.load_calendar().set_index("date").note.reindex(cal.date).fillna("").values
    pd.DataFrame({"date": cal.date.dt.strftime("%Y-%m-%d"), "day_type": kind,
                  "is_holiday": (kind == "holiday").astype(int) | days.reindex(cal.date).hol_we.values,
                  "is_preholiday": cal.pre.values, "school_break": cal.school.values | days.reindex(cal.date).school.values,
                  "note": notes}).to_csv(ARTIFACTS / "calendar.csv", index=False, lineterminator=LF)

    wx = external.weather_for(pd.date_range("2025-01-01", FORECAST_TO))
    pd.DataFrame({"date": wx.index.strftime("%Y-%m-%d"), "t_mean": wx.t_mean.round(1), "precip_mm": wx.precip_mm.round(1),
                  "snow_cm": wx.snow_cm.round(1), "rain_day_mm": wx.rain_day.round(1), "snow_day_cm": wx.snow_day.round(2),
                  "source": wx.source}).to_csv(ARTIFACTS / "weather_daily.csv", index=False, lineterminator=LF)

    ev = external.load_events()
    ev_out = ev.assign(factor=event_effects(hourly, ev, days),
                       date_from=ev.date_from.dt.strftime("%Y-%m-%d"), date_to=ev.date_to.dt.strftime("%Y-%m-%d"))
    ev_out[["route", "date_from", "date_to", "days", "factor", "title", "source_url"]].to_csv(ARTIFACTS / "events.csv", index=False, lineterminator=LF)

    b = model.beta
    factors = {
        "weather": {
            "coef": {k: round(float(b[k]), 5) for k in ("rain_warm", "rain_we", "snow", "heat", "cold")},
            "rain_warm_min_t": 12, "heat_above_t": 20, "cold_below_t": -5,
        },
        "formula": ("Для каждого дня: t = t_mean + temp_delta; дневные осадки и снег из сценария, если заданы, иначе из прогноза погоды; "
                    "признаки rain_warm = ln(1+дождь) в будни при t >= 12, rain_we = ln(1+дождь) в нерабочие дни, snow = ln(1+снег), "
                    "heat = max(t-20, 0), cold = max(-5-t, 0); множитель = exp(сумма coef x (признак сценария - признак прогноза)) "
                    "x (1 + event_pct/100) x (1 + season_pct/100)"),
        "limits": {"temp_delta": [-15, 15], "precip_mm": [0, 20], "snow_cm": [0, 5], "event_pct": [-100, 100], "season_pct": [-30, 30]},
        "presets": [
            {"id": "snowfall", "title": "Снегопад", "temp_delta": -3, "precip_mm": 0, "snow_cm": 5, "event_pct": 0, "season_pct": 0},
            {"id": "rain", "title": "Затяжной дождь", "temp_delta": 0, "precip_mm": 12, "snow_cm": 0, "event_pct": 0, "season_pct": 0},
            {"id": "heat", "title": "Жара", "temp_delta": 8, "precip_mm": 0, "snow_cm": 0, "event_pct": 0, "season_pct": 0},
            {"id": "closure", "title": "Закрытие участка", "temp_delta": 0, "precip_mm": 0, "snow_cm": 0, "event_pct": -60, "season_pct": 0},
            {"id": "event", "title": "Массовое мероприятие", "temp_delta": 0, "precip_mm": 0, "snow_cm": 0, "event_pct": 25, "season_pct": 0},
            {"id": "summer", "title": "Летний спад", "temp_delta": 0, "precip_mm": 0, "snow_cm": 0, "event_pct": 0, "season_pct": -20},
        ],
        "note": ("Погодные коэффициенты - те же, что в модели уровня дня, и применяются по тем же правилам: дождь в будни влияет только в тёплую погоду, "
                 "жара - выше 20 °C. Мороз в данных 2025 года на поездки почти не влиял, его коэффициент близок к нулю. "
                 "Осадки и снег - за дневные часы 7-21, в пределах, которые встречались в истории."),
    }
    (ARTIFACTS / "factors.json").write_text(json.dumps(factors, ensure_ascii=False, indent=1), encoding="utf-8", newline=LF)

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
            "special_rules": ["31 декабря: профиль воскресенья, вечером посадки ниже обычного (17 ч x0.9, 20 ч x0.7, 22-23 ч x0.45)",
                              "Маршрут 5 с 16 декабря 2025: 35% уровня маршрута 25 и его почасовой профиль (своей истории нет)"],
            "trained_until": AS_OF,
        },
        "backtests": bt.get("backtests", []),
        "by_route": bt.get("by_route", []),
        "external_effects": bt.get("external_effects", []),
        "intervals": {"p10_ratio": round(q["p10"], 3), "p90_ratio": round(q["p90"], 3),
                      "note": "p10 и p90 - квантили отношения факт/прогноз дневной суммы маршрута на исторических окнах"},
    }
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=1), encoding="utf-8", newline=LF)
    (ARTIFACTS / "model.json").write_text(json.dumps(model_card(model, months), ensure_ascii=False), encoding="utf-8", newline=LF)
    print("submission rows", len(sub), "total", int(sub.prediction.sum()))
    print("coefficients", metrics["model"]["coefficients"])


if __name__ == "__main__":
    main()
