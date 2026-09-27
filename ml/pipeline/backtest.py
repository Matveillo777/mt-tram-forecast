"""Rolling-origin backtests and the effect of each external source.

    python -m pipeline.backtest

Every window is forecast from what was known on its origin date: history up to it, news published by then,
observed weather up to it and the climate average after it. Scored on the full
route x day x hour grid with the organizers' metric WAPE-score = max(0, 1 - sum|y - yhat| / sum y).
"""
import json

import numpy as np
import pandas as pd

from .data import ARTIFACTS, honest_inputs, load_inputs
from .model import ROUTES, Forecaster, wape_score

WINDOWS = [  # (origin = last known day, last forecast day)
    ("2025-02-28", "2025-04-30"),
    ("2025-03-31", "2025-05-31"),
    ("2025-04-30", "2025-06-30"),
    ("2025-05-31", "2025-07-31"),
    ("2025-06-30", "2025-08-31"),
    ("2025-08-31", "2025-10-31"),
    ("2025-09-30", "2025-10-31"),
]
# forecasts refreshed on the day a service-change notice was published, before the change started
NEWS_WINDOWS = [("2025-07-08", "2025-08-31"), ("2025-08-01", "2025-09-05"), ("2025-09-05", "2025-10-31")]
ABLATIONS = {
    "Погода (Open-Meteo)": {"use_weather": False},
    "Календарь и каникулы": {"use_calendar": False},
    "Ремонты и изменения маршрутов (новости)": {"drop_kinds": {"closure", "shortened", "reroute"}},
    "Очистка аномалий в данных": {"drop_kinds": {"anomaly"}},
}


def run_window(hourly, days, events, origin, end, honest=True, drop_kinds=(), **kw):
    if honest:
        days, events = honest_inputs(days, events, origin)
    events = events[~events.kind.isin(drop_kinds)]
    f = Forecaster(**kw).fit(hourly, days, events, origin)
    dates = pd.date_range(pd.Timestamp(origin) + pd.Timedelta(days=1), end)
    pred = f.predict(dates)
    truth = hourly[(hourly.date >= dates[0]) & (hourly.date <= dates[-1])]
    m = truth.merge(pred, on=["route", "date", "hour"])
    m["p50"] = m.p50.round()
    return m, f


def main():
    hourly, days, events, sources = load_inputs()
    backtests, effects, residuals = [], [], []
    by_route = None
    for origin, end in WINDOWS:
        m, _ = run_window(hourly, days, events, origin, end)
        score = wape_score(m.boardings, m.p50)
        mo, _ = run_window(hourly, days, events, origin, end, honest=False)
        row = {"name": f"{origin[5:]} -> {end[5:]}", "origin": origin, "horizon_days": (pd.Timestamp(end) - pd.Timestamp(origin)).days,
               "wape_score": round(score, 4), "wape_score_known_weather_and_news": round(wape_score(mo.boardings, mo.p50), 4)}
        for name, kw in ABLATIONS.items():
            ma, _ = run_window(hourly, days, events, origin, end, **kw)
            row[name] = round(wape_score(ma.boardings, ma.p50), 4)
        backtests.append(row)
        daily = m.groupby(["route", "date"])[["boardings", "p50"]].sum()
        daily = daily[daily.p50 > 0]
        residuals.append(np.log(daily.boardings.clip(lower=1) / daily.p50))
        if origin == "2025-08-31":
            by_route = [{"route": int(r), "wape_score": round(wape_score(g.boardings, g.p50), 4)} for r, g in m.groupby("route") if g.boardings.sum() > 0]
        print(row)
    cleaning = None
    for name in ABLATIONS:
        without = float(np.mean([b[name] for b in backtests]))
        with_ = float(np.mean([b["wape_score"] for b in backtests]))
        if name.startswith("Ремонты"):
            news_standard = {"without": round(without, 4), "with": round(with_, 4), "delta": round(with_ - without, 4)}
            continue  # news rarely precede a window start; the effect is measured on publication days below
        if name.startswith("Очистка"):
            # data cleaning, not an external source: reported apart
            cleaning = {"without": round(without, 4), "with": round(with_, 4), "delta": round(with_ - without, 4),
                        "note": sources[name]["note"]}
            continue
        effects.append({"source": name, "metric": "средний WAPE-score по окнам", "without": round(without, 4), "with": round(with_, 4),
                        "delta": round(with_ - without, 4), "note": sources.get(name, {}).get("note", ""),
                        "url": sources.get(name, {}).get("url", "")})
    news_rows = []
    for origin, end in NEWS_WINDOWS:
        m, _ = run_window(hourly, days, events, origin, end)
        mn, _ = run_window(hourly, days, events, origin, end, drop_kinds={"closure", "shortened", "reroute"})
        news_rows.append({"origin": origin, "end": end, "with_news": round(wape_score(m.boardings, m.p50), 4),
                          "without_news": round(wape_score(mn.boardings, mn.p50), 4)})
        print(news_rows[-1])
    w, wo = np.mean([r["with_news"] for r in news_rows]), np.mean([r["without_news"] for r in news_rows])
    effects.append({"source": "Новости об изменении маршрутов", "metric": "прогноз, обновлённый в день выхода новости, средний WAPE-score",
                    "without": round(float(wo), 4), "with": round(float(w), 4), "delta": round(float(w - wo), 4),
                    "note": "прогнозы от 8 июля и 5 сентября 2025 года (дни выхода новостей о работах на маршрутах 7 и 50) и от 1 августа (известна дата окончания июльских работ)",
                    "url": sources["Ремонты и изменения маршрутов (новости)"]["url"]})
    # where the error lives: the same October window with the true daily totals of each route put in
    m, _ = run_window(hourly, days, events, "2025-09-30", "2025-10-31")
    true_day = m.groupby(["route", "date"]).boardings.transform("sum")
    pred_day = m.groupby(["route", "date"]).p50.transform("sum")
    oracle = (m.p50 * np.where(pred_day > 0, true_day / pred_day, 0)).round()
    level_oracle = round(wape_score(m.boardings, oracle), 4)
    print("October with true daily totals:", level_oracle)
    two_months = [b["wape_score"] for b in backtests if b["horizon_days"] >= 60]
    summary = {"mean": round(float(np.mean([b["wape_score"] for b in backtests])), 4),
               "mean_two_months": round(float(np.mean(two_months)), 4),
               "mean_known_weather_and_news": round(float(np.mean([b["wape_score_known_weather_and_news"] for b in backtests])), 4),
               "october_with_true_daily_totals": level_oracle}
    res = np.concatenate(residuals)
    quantiles = {"p10": float(np.exp(np.quantile(res, 0.10))), "p90": float(np.exp(np.quantile(res, 0.90)))}
    out = {"mode": "на начало окна известны только погода и новости до этой даты, после неё берётся климатическая норма",
           "summary": summary, "news_windows": news_rows, "news_on_standard_windows": news_standard, "data_cleaning": cleaning,
           "backtests": backtests, "by_route": by_route, "external_effects": effects, "daily_ratio_quantiles": quantiles}
    (ARTIFACTS / "backtest.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8", newline=chr(10))
    print(json.dumps(effects, ensure_ascii=False, indent=1))
    print(summary)
    print("quantiles of daily actual/forecast:", quantiles)


if __name__ == "__main__":
    main()
