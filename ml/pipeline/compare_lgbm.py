"""LightGBM against the Forecaster on the backtest windows (docs/model.md).

    python -m pipeline.compare_lgbm

Same rolling-origin windows as backtest.py: every model is trained on data up to the
window's origin only, then scored on the full route x day x hour grid with the
organizers' WAPE-score, rounded like backtest.py does for the Forecaster.
"""
import json

import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor

from .backtest import WINDOWS, run_window
from .data import ARTIFACTS, honest_inputs, load_inputs
from .model import CALENDAR, ROUTES, WEATHER, wape_score

SEED = 0
PROFILE_WEEKS = 4
PROFILE_EPS = 0.5  # keeps the ratio target finite on hours with a near-zero profile
KIND_CATEGORIES = ["mon", "mid", "fri", "sat", "sun", "hol", "work_sat"]
CATEGORICAL = ["route", "kind"]
FEATURE_COLS = ["route", "hour", "dow", "kind"] + CALENDAR + WEATHER + ["horizon"]

LGBM_PARAMS = dict(
    n_estimators=200,
    num_leaves=31,
    learning_rate=0.05,
    min_child_samples=30,
    subsample=0.8,
    subsample_freq=1,
    colsample_bytree=0.8,
    random_state=SEED,
    n_jobs=4,
    verbosity=-1,
)


def _profile_table(hist: pd.DataFrame, origin: str) -> pd.Series:
    """Median boardings per route x weekday x hour over the last PROFILE_WEEKS before origin."""
    start = pd.Timestamp(origin) - pd.Timedelta(weeks=PROFILE_WEEKS)
    win = hist[hist.date > start].copy()
    win["dow"] = win.date.dt.dayofweek
    return win.groupby(["route", "dow", "hour"]).boardings.median()


def _profile_lookup(prof: pd.Series, frame: pd.DataFrame) -> np.ndarray:
    """route x weekday x hour, falling back to route x hour for combos absent from the window."""
    fallback = prof.groupby(level=[0, 2]).median()
    vals = prof.reindex(pd.MultiIndex.from_arrays([frame.route, frame.dow, frame.hour])).to_numpy(dtype=float, copy=True)
    miss = np.isnan(vals)
    if miss.any():
        vals[miss] = fallback.reindex(pd.MultiIndex.from_arrays([frame.route[miss], frame.hour[miss]])).values
    return np.nan_to_num(vals, nan=0.0)


def _feature_frame(hourly: pd.DataFrame, days: pd.DataFrame, origin: str) -> pd.DataFrame:
    f = hourly.copy()
    f["dow"] = f.date.dt.dayofweek
    d = days.reindex(f.date.values)
    f["kind"] = pd.Categorical(d.kind.values, categories=KIND_CATEGORIES)
    for c in CALENDAR + WEATHER:
        f[c] = d[c].values
    f["horizon"] = (f.date - pd.Timestamp(origin)).dt.days
    f["route"] = pd.Categorical(f.route, categories=ROUTES)
    return f


def _fit_predict(train: pd.DataFrame, ratio: np.ndarray, test: pd.DataFrame, profile_test: np.ndarray, **objective) -> np.ndarray:
    reg = LGBMRegressor(**LGBM_PARAMS, **objective).fit(train[FEATURE_COLS], ratio, categorical_feature=CATEGORICAL)
    pred_ratio = np.clip(reg.predict(test[FEATURE_COLS]), 0, None)
    return pred_ratio * (profile_test + PROFILE_EPS)


def run_compare(hourly, days, events, origin, end):
    m_fc, _ = run_window(hourly, days, events, origin, end)
    fc_score = wape_score(m_fc.boardings, m_fc.p50)

    hist = hourly[hourly.date <= origin]
    prof = _profile_table(hist, origin)
    train = _feature_frame(hist, days, origin)
    profile_train = _profile_lookup(prof, train)
    ratio = train.boardings.values / (profile_train + PROFILE_EPS)

    dates = pd.date_range(pd.Timestamp(origin) + pd.Timedelta(days=1), end)
    truth = hourly[(hourly.date >= dates[0]) & (hourly.date <= dates[-1])]
    # same knowledge as the Forecaster in backtest.py: no weather from after the origin
    days_known, _ = honest_inputs(days, events, origin)
    test = _feature_frame(truth, days_known, origin)
    profile_test = _profile_lookup(prof, test)

    pred_l1 = _fit_predict(train, ratio, test, profile_test, objective="regression_l1")
    pred_2 = _fit_predict(train, ratio, test, profile_test, objective="tweedie", tweedie_variance_power=1.3)
    fc = test[["route", "date", "hour"]].astype({"route": int}).merge(m_fc[["route", "date", "hour", "p50"]], how="left").p50.fillna(0).values
    blend = 0.5 * fc + 0.5 * pred_l1

    return {
        "origin": origin,
        "forecaster": round(fc_score, 4),
        "lgbm_l1": round(wape_score(test.boardings, np.round(pred_l1)), 4),
        "lgbm_2": round(wape_score(test.boardings, np.round(pred_2)), 4),
        "profile": round(wape_score(test.boardings, np.round(profile_test)), 4),
        "blend_forecaster_lgbm_l1": round(wape_score(test.boardings, np.round(blend)), 4),
    }


def main():
    hourly, days, events, _ = load_inputs()
    windows = [run_compare(hourly, days, events, origin, end) for origin, end in WINDOWS]
    for row in windows:
        print(row)
    keys = ("forecaster", "lgbm_l1", "lgbm_2", "profile", "blend_forecaster_lgbm_l1")
    mean = {k: round(float(np.mean([w[k] for w in windows])), 4) for k in keys}
    out = {"windows": windows, "mean": mean}
    (ARTIFACTS / "lgbm_compare.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8", newline=chr(10))
    print("mean:", mean)


if __name__ == "__main__":
    main()
