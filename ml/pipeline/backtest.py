"""Rolling-origin backtests and the effect of each external source.

    python -m pipeline.backtest

Every window is forecast from data up to its origin only (no look-ahead), scored on the full
route x day x hour grid with the organizers' metric WAPE-score = max(0, 1 - sum|y - yhat| / sum y).
"""
import json

import numpy as np
import pandas as pd

from .data import ARTIFACTS, load_inputs
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
ABLATIONS = {
    "Погода (Open-Meteo)": {"use_weather": False},
    "Календарь и каникулы": {"use_calendar": False},
    "Ремонты и перекрытия (новости)": {"use_events": False},
}


def run_window(hourly, days, events, origin, end, **kw):
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
        row = {"name": f"{origin[5:]} -> {end[5:]}", "origin": origin, "horizon_days": (pd.Timestamp(end) - pd.Timestamp(origin)).days,
               "wape_score": round(score, 4)}
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
    for name in ABLATIONS:
        without = float(np.mean([b[name] for b in backtests]))
        with_ = float(np.mean([b["wape_score"] for b in backtests]))
        effects.append({"source": name, "metric": "средний WAPE-score по окнам", "without": round(without, 4), "with": round(with_, 4),
                        "delta": round(with_ - without, 4), "note": sources.get(name, {}).get("note", ""),
                        "url": sources.get(name, {}).get("url", "")})
    res = np.concatenate(residuals)
    quantiles = {"p10": float(np.exp(np.quantile(res, 0.10))), "p90": float(np.exp(np.quantile(res, 0.90)))}
    out = {"backtests": backtests, "by_route": by_route, "external_effects": effects, "daily_ratio_quantiles": quantiles}
    (ARTIFACTS / "backtest.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(effects, ensure_ascii=False, indent=1))
    print("quantiles of daily actual/forecast:", quantiles)


if __name__ == "__main__":
    main()
