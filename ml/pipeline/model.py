"""Hourly boardings forecast: daily level per route x hourly profile.

level(route, day) = base(route, day kind) * exp(beta . x_day) * month_factor * event_factor
hourly(route, day, hour) = level * profile(route, day kind, hour)

base      - median daily boardings of the latest clean weeks, with the weather effect removed
x_day     - calendar and weather features (holidays, pre-holidays, school breaks, rain, snow, heat, cold)
beta      - ridge regression on log(day / trailing base) over the whole history (scikit-learn)
profile   - mean normalized hourly shape of the latest 4 clean weeks
"""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

ROUTES = [1, 5, 7, 11, 12, 17, 25, 26, 28, 50]
CALENDAR = ["hol", "hol_we", "pre", "school"]
WEATHER = ["rain_warm", "rain_we", "snow", "heat", "cold"]
SHAPE_OF_DOW = {0: "mon", 1: "mid", 2: "mid", 3: "mid", 4: "fri", 5: "sat", 6: "sun"}
FEATURES = ["hol", "hol_we", "pre", "school", "rain_warm", "rain_we", "snow", "heat", "cold"]


def day_table(dates, cal: pd.DataFrame, weather: pd.DataFrame) -> pd.DataFrame:
    """Calendar kind and model features for each date."""
    d = pd.DataFrame(index=pd.DatetimeIndex(dates, name="date"))
    c = cal.set_index("date").reindex(d.index)
    dow = d.index.dayofweek
    d["dow"] = dow
    is_hol = c.is_holiday.fillna(0).astype(int).values == 1
    work_sat = (c.day_type.values == "workday") & (dow >= 5)
    d["kind"] = np.where(work_sat, "work_sat",
                np.where(is_hol & (dow < 5), "hol", [SHAPE_OF_DOW[x] for x in dow]))
    weekend = (dow >= 5) & ~work_sat
    d["weekend"] = weekend.astype(int)
    # non-working day: an ordinary weekend or a holiday; "по выходным" in service notices means these days
    d["offday"] = (weekend | is_hol).astype(int)
    d["hol"] = (is_hol & (dow < 5)).astype(int)
    d["hol_we"] = (is_hol & (dow >= 5)).astype(int)
    d["pre"] = c.is_preholiday.fillna(0).astype(int).values
    d["school"] = (c.school_break.fillna(0).astype(int).values == 1) & ~weekend & ~is_hol
    d["school"] = d.school.astype(int)
    w = weather.reindex(d.index)
    d["t_mean"] = w.t_mean.values
    # daytime (7-21 h) precipitation with saturation: a night downpour does not keep people at home
    d["rain"] = np.log1p(w.rain_day.fillna(0).values)
    d["snow"] = np.log1p(w.snow_day.fillna(0).values)
    # on cold working days rain does not stop commuting (October 2025 data), in warm months it cuts leisure trips
    d["rain_warm"] = d.rain * (d.t_mean >= 12) * ~(weekend | is_hol)
    d["rain_we"] = d.rain * (weekend | is_hol)
    d["snow_we"] = d.snow * (weekend | is_hol)
    d["heat"] = np.maximum(d.t_mean - 20, 0)
    d["cold"] = np.maximum(-5 - d.t_mean, 0)
    return d


EVENT_FACTOR = {"closure": 0.05}


def _covers(days: str, offday) -> bool:
    return days == "all" or (days == "weekend" and bool(offday)) or (days == "workday" and not offday)


def base_kind(kind: str) -> str:
    """Which regular day kind a day borrows its base level from."""
    return {"hol": "sun", "work_sat": "mid"}.get(kind, kind)


@dataclass
class Forecaster:
    shape_weeks: int = 4
    base_weeks: int = 3
    alpha: float = 3.0
    month_factor: dict = field(default_factory=dict)
    use_weather: bool = True
    use_calendar: bool = True
    use_events: bool = True
    # days the 2025 history has no example of: expert multipliers on top of the model
    # routes launched inside the forecast period: no history, level taken from a similar short route
    new_routes: dict = field(default_factory=lambda: {
        5: {"from": "2025-12-16", "like": 25, "share": 0.35},  # 4.4 km, 7 cars, launched 2025-12-16 (mos.ru)
    })
    special_days: dict = field(default_factory=lambda: {
        "work_sat": 0.88,       # transferred working Saturday vs midweek; with pre-holiday and school break effects about 0.8
        "12-29": 0.90,          # last working days before the 12-day New Year break
        "12-30": 0.88,
    })

    def fit(self, hourly: pd.DataFrame, days: pd.DataFrame, events: pd.DataFrame, as_of) -> "Forecaster":
        """hourly: route,date,hour,boardings (full grid up to as_of); days: day_table covering the history."""
        self.as_of = pd.Timestamp(as_of)
        h = hourly[pd.to_datetime(hourly.date) <= self.as_of]
        mat = h.pivot_table(index=["route", "date"], columns="hour", values="boardings", aggfunc="sum").fillna(0)
        mat.index = pd.MultiIndex.from_arrays([mat.index.get_level_values(0), pd.to_datetime(mat.index.get_level_values(1))])
        total = mat.sum(axis=1)
        self.events = events if self.use_events else events.iloc[0:0]
        if not self.use_calendar:
            # without the calendar a holiday is just another day of the week
            days = days.copy()
            days["kind"] = [SHAPE_OF_DOW[x] for x in days.dow]
            days[CALENDAR] = 0
        self.days = days
        dk = days.reindex(total.index.get_level_values(1))
        daily = pd.DataFrame({"route": total.index.get_level_values(0), "date": total.index.get_level_values(1),
                              "total": total.values, "kind": dk.kind.values})
        daily["event"] = self._event_mask(daily.route.values, daily.date)
        daily["bkind"] = daily.kind.map(base_kind)
        self.daily = daily
        self._fit_level_model(daily)
        clean = daily[(daily.event == 0) & ~daily.kind.isin(["hol", "work_sat"]) & (days.reindex(daily.date).school.values == 0)]
        self._fit_base(daily, clean)
        self._fit_profiles(mat, clean)
        return self

    def _event_mask(self, routes, dates) -> np.ndarray:
        m = np.zeros(len(dates), dtype=int)
        off = self.days.offday.reindex(pd.DatetimeIndex(dates)).fillna(0).values
        for e in self.events.itertuples():
            sel = (routes == e.route) & (dates >= e.date_from).values & (dates <= e.date_to).values
            sel &= np.array([_covers(e.days, x) for x in off])
            m[sel] = 1
        return m

    def _weather_part(self, x: pd.DataFrame) -> np.ndarray:
        cols = [c for c in FEATURES if c in WEATHER]
        return x[cols].values @ np.array([self.beta[c] for c in cols])

    def _fit_level_model(self, daily: pd.DataFrame):
        """Ridge on log(day total / trailing 4-week median of the same kind)."""
        rows = []
        for r, g in daily[daily.route != 5].groupby("route"):
            g = g.sort_values("date")
            ok = g[(g.event == 0) & ~g.kind.isin(["hol", "work_sat"])]
            for kind in g.bkind.unique():
                ref = ok[ok.kind == kind].set_index("date").total
                roll = ref.rolling("28D", closed="left").median()
                cnt = ref.rolling("28D", closed="left").count()
                target = g[(g.bkind == kind) & (g.event == 0)]
                b = roll.reindex(target.date, method="ffill").values
                n = cnt.reindex(target.date, method="ffill").values
                keep = (n >= 2) & (b > 0) & (target.total.values > 0)
                rows.append(pd.DataFrame({"route": r, "date": target.date.values[keep],
                                          "y": np.log(target.total.values[keep] / b[keep]), "w": b[keep]}))
        tr = pd.concat(rows)
        x = self.days.reindex(tr.date)[FEATURES].copy()
        if not self.use_calendar:
            x[CALENDAR] = 0
        if not self.use_weather:
            x[WEATHER] = 0
        # every factor can only lower ridership, hence the sign constraint
        model = Ridge(alpha=self.alpha, positive=True).fit(-x.values, tr.y.values, sample_weight=np.sqrt(tr.w.values))
        self.beta = dict(zip(FEATURES, -model.coef_))
        self.level_fit = {"rows": len(tr), "intercept": float(model.intercept_)}

    def _fit_base(self, daily, clean):
        """Weather-neutral median daily level per route and kind over the latest clean weeks."""
        start = self.as_of - pd.Timedelta(weeks=self.base_weeks)
        win = clean[clean.date > start].copy()
        x = self.days.reindex(win.date)
        win["adj"] = win.total.values / np.exp(self._weather_part(x) if self.use_weather else 0)
        self.base = win.groupby(["route", "kind"]).adj.median()
        # fall back to longer windows for kinds missing in the latest weeks (e.g. long closures)
        longer = clean.copy()
        longer["adj"] = longer.total.values / np.exp(self._weather_part(self.days.reindex(longer.date)) if self.use_weather else 0)
        longer = longer[longer.date > self.as_of - pd.Timedelta(weeks=12)]
        self.base_long = longer.groupby(["route", "kind"]).adj.median()
        # level during an event that is active at as_of (e.g. weekend closure): its own recent median
        ev = daily[(daily.event == 1) & (daily.date > start)]
        self.base_event = ev.groupby(["route", "bkind"]).total.median()
        recent = daily[(daily.date > self.as_of - pd.Timedelta(weeks=12)) & ~daily.kind.isin(["hol", "work_sat"])]
        self.base_any = recent.groupby(["route", "bkind"]).total.median()
        # normal weekend/weekday ratio for restoring a route after an event (spring, before any 2025 closures)
        spring = clean[(clean.date >= "2025-02-01") & (clean.date <= "2025-05-31")]
        lv = spring.groupby(["route", "kind"]).total.median()
        with np.errstate(invalid="ignore", divide="ignore"):  # route 5 has no boardings at all
            self.restore_ratio = {(r, k): lv.get((r, k), np.nan) / lv.get((r, "mid"), np.nan) for r, k in lv.index}

    def _fit_profiles(self, mat, clean):
        start = self.as_of - pd.Timedelta(weeks=self.shape_weeks)
        win = clean[(clean.date > start) & (clean.total > 0)]
        prof = {}
        for (r, kind), g in win.groupby(["route", "kind"]):
            rows = mat.loc[list(zip(g.route, g.date))].values
            prof[(r, kind)] = (rows / rows.sum(axis=1, keepdims=True)).mean(axis=0)
        # older weeks for kinds with no clean days recently (route 50 weekends)
        older = clean[(clean.date > start - pd.Timedelta(weeks=12)) & (clean.total > 0)]
        for (r, kind), g in older.groupby(["route", "kind"]):
            if (r, kind) not in prof:
                rows = mat.loc[list(zip(g.route, g.date))].values
                prof[(r, kind)] = (rows / rows.sum(axis=1, keepdims=True)).mean(axis=0)
        self.profiles = prof
        ev = self.daily[(self.daily.event == 1) & (self.daily.date > start) & (self.daily.total > 0)]
        self.profiles_event = {}
        for (r, kind), g in ev.groupby(["route", "bkind"]):
            rows = mat.loc[list(zip(g.route, g.date))].values
            self.profiles_event[(r, kind)] = rows.sum(axis=0) / rows.sum()

    def _base_for(self, r, kind, active, restored):
        bk = base_kind(kind)
        if active and (r, bk) in self.base_event:
            return self.base_event[(r, bk)]
        b = self.base.get((r, bk), np.nan)
        if restored or np.isnan(b):
            # back to normal service: the route's usual ratio of this day kind to midweek
            b_restored = self.base.get((r, "mid"), np.nan) * self.restore_ratio.get((r, bk), np.nan)
            b = b_restored if not np.isnan(b_restored) else b
        if np.isnan(b):
            b = self.base_long.get((r, bk), np.nan)
        if np.isnan(b):
            # every recent day of this kind was disrupted: take those days as they are
            b = self.base_any.get((r, bk), 0.0)
        return b

    def _profile_for(self, r, kind, event_active):
        if r in self.new_routes:
            r = self.new_routes[r]["like"]
        if event_active and (r, base_kind(kind)) in self.profiles_event:
            return self.profiles_event[(r, base_kind(kind))]
        if kind == "hol":
            return self.profiles.get((r, "sun"), np.full(24, 1 / 24))
        if kind == "work_sat":
            return 0.6 * self.profiles.get((r, "fri"), 0) + 0.4 * self.profiles.get((r, "sat"), 0)
        return self.profiles.get((r, kind), self.profiles.get((r, "mid"), np.full(24, 1 / 24)))

    def daily_forecast(self, dates) -> pd.DataFrame:
        days = self.days.reindex(pd.DatetimeIndex(dates))
        x = days[FEATURES].copy()
        if not self.use_calendar:
            x[CALENDAR] = 0
        if not self.use_weather:
            x[WEATHER] = 0
        eff = np.exp(x.values @ np.array([self.beta[c] for c in FEATURES]))
        # events running on the forecast date: after they end the route returns to its usual level
        current = self.events[(self.events.date_from <= self.as_of) & (self.events.date_to >= self.as_of)]
        out = []
        for r in ROUTES:
            active = self._event_mask(np.full(len(days), r), days.index.to_series())
            ends = list(current[current.route == r].itertuples())
            for i, (day, row) in enumerate(days.iterrows()):
                restored = any(day > e.date_to and _covers(e.days, row.offday) for e in ends)
                if r in self.new_routes:
                    b = self._new_route_base(r, day, row.kind)
                else:
                    b = self._base_for(r, row.kind, active[i] == 1, restored)
                level = b * eff[i] * self.month_factor.get(day.month, 1.0) * self._special(day, row.kind)
                if active[i] == 1 and (r, base_kind(row.kind)) not in self.base_event:
                    level *= self._event_factor(r, day)
                out.append((r, day, row.kind, level, active[i]))
        return pd.DataFrame(out, columns=["route", "date", "kind", "level", "event"])

    def _new_route_base(self, r, day, kind):
        nr = self.new_routes[r]
        if day < pd.Timestamp(nr["from"]) or not self.use_events:
            return 0.0
        return nr["share"] * self._base_for(nr["like"], kind, False, False)

    def _special(self, day, kind):
        if not self.use_calendar:
            return 1.0
        if kind == "work_sat":
            return self.special_days.get("work_sat", 1.0)
        return self.special_days.get(day.strftime("%m-%d"), 1.0)

    def _event_factor(self, r, day):
        """Event that starts after the forecast date: no own history yet, only a full closure is priced in."""
        for e in self.events.itertuples():
            if e.route == r and e.date_from <= day <= e.date_to and _covers(e.days, self.days.offday.get(day, 0)):
                return EVENT_FACTOR.get(e.kind, 1.0)
        return 1.0

    def predict(self, dates) -> pd.DataFrame:
        daily = self.daily_forecast(dates)
        hours = np.arange(24)
        rows = []
        for d in daily.itertuples():
            prof = self._profile_for(d.route, d.kind, d.event == 1)
            vals = d.level * np.asarray(prof)
            if d.date.month == 12 and d.date.day == 31:
                vals = vals * np.interp(hours, [0, 16, 17, 20, 22, 23], [1, 1, 0.9, 0.7, 0.45, 0.45])
            rows.append(pd.DataFrame({"route": d.route, "date": d.date, "hour": hours, "p50": vals}))
        return pd.concat(rows, ignore_index=True)


def wape_score(y, yhat) -> float:
    return max(0.0, 1 - np.abs(np.asarray(y) - np.asarray(yhat)).sum() / np.asarray(y).sum())
