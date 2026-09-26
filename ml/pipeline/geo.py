"""Route geometry, ordered stops and rail-transfer flags for all 10 routes,
plus geo-binding of validations onto stops (stop_shares.csv).

The raw dataset has no GPS at all, so two things are approximated here and
both are documented inline where they happen:
  - which OSM stop sequence to use for the 5 routes the organizers' own
    workbook does not cover (see WORKBOOK_ROUTES);
  - how a validation without any location is placed onto a stop along the
    route (see build_stop_shares).

Sources:
  - organizers' workbook (routes 1, 5, 7, 11, 12 only - the rest are not in it):
    real ordered stops with coordinates.
  - OpenStreetMap via Overpass: line geometry for every route (always), and
    stops for the other five routes (17, 25, 26, 28, 50).
  - OSM metro/MCC/MCD/railway stations: near_rail flag.

Run: python -m pipeline.geo   (from ml/, after ingest.py has produced vehicle_events_TEST.parquet)
"""
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

import duckdb

from . import config as cfg

WORKBOOK = cfg.RAW_DIR / "spravochniki" / "Хакатон_справочники_трамвай_10_маршрутов.xlsx"
# the workbook's own route/stop sheets only cover these 5 of the 10 routes
# (checked directly: distinct route_short_name values in "Порядок_с_координатами").
WORKBOOK_ROUTES = {1, 5, 7, 11, 12}

# Moscow incl. outskirts - generous so no route endpoint is clipped.
BBOX = (55.4, 37.2, 56.0, 37.9)

# overpass-api.de itself (and its usual mirrors under the same domain) returned
# a bare 406 to every request from this host during development - a network-level
# block, not a query problem (plain www.openstreetmap.org worked fine). These two
# independent mirrors answered normally; keep both, in that order, with retries.
OVERPASS_MIRRORS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

NEAR_RAIL_M = 350

# categorical palette (tab10-derived): 10 hues spread around the wheel, no grey
# (grey reads as "unmapped" on top of a light basemap), good light/dark contrast.
ROUTE_COLORS = {
    1: "#1f77b4", 5: "#e377c2", 7: "#2ca02c", 11: "#ff7f0e", 12: "#17becf",
    17: "#9467bd", 25: "#d62728", 26: "#8c564b", 28: "#bcbd22", 50: "#393b79",
}

STOP_ROLES = ("stop", "stop_entry_only", "stop_exit_only")
PLATFORM_ROLES = ("platform", "platform_entry_only", "platform_exit_only")


def _overpass_raw(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_err = None
    for mirror in OVERPASS_MIRRORS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(
                    mirror, data=body, headers={"User-Agent": "mt-tram-forecast-hackathon/1.0"}
                )
                with urllib.request.urlopen(req, timeout=180) as resp:
                    return json.loads(resp.read())
            except Exception as e:  # noqa: BLE001 - network can fail many ways, all are retried the same
                last_err = e
                time.sleep(3)
    raise RuntimeError(f"all overpass mirrors failed: {last_err}")


def _haversine_m(a, b):
    """a, b are (lon, lat) pairs."""
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _fetch_route_relations():
    """One relation pair (there/back) per route number, cached per route so a
    rerun never touches the network again. Returns {route: [relation, ...]}."""
    cfg.OSM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    missing = [r for r in cfg.ROUTES if not (cfg.OSM_CACHE_DIR / f"route_{r}.json").exists()]
    if missing:
        refs = "|".join(str(r) for r in missing)
        query = (
            "[out:json][timeout:180];\n"
            f'relation["route"="tram"]["ref"~"^({refs})$"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});\n'
            "out body;\n>;\nout body geom;"
        )
        data = _overpass_raw(query)
        els = data["elements"]
        by_ref = defaultdict(list)
        for e in els:
            if e["type"] == "relation":
                ref = e.get("tags", {}).get("ref")
                if ref and ref.isdigit():
                    by_ref[int(ref)].append(e)
        for r in missing:
            rels = by_ref.get(r, [])
            member_ids = {(m["type"], m["ref"]) for rel in rels for m in rel["members"]}
            closure = [e for e in els if e["type"] == "relation" and e in rels] + [
                e for e in els if (e["type"], e["id"]) in member_ids
            ]
            (cfg.OSM_CACHE_DIR / f"route_{r}.json").write_text(
                json.dumps(closure, ensure_ascii=False), encoding="utf-8"
            )

    out = {}
    for r in cfg.ROUTES:
        els = json.loads((cfg.OSM_CACHE_DIR / f"route_{r}.json").read_text(encoding="utf-8"))
        out[r] = [e for e in els if e["type"] == "relation"]
        out[f"{r}_els"] = els  # stash the closure for member lookups below (see _pick_relation)
    return out


def _fetch_stations():
    cache = cfg.OSM_CACHE_DIR / "stations.json"
    if not cache.exists():
        cfg.OSM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        query = (
            "[out:json][timeout:120];\n(\n"
            f'  node["railway"="station"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});\n'
            f'  node["station"="subway"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});\n'
            f'  node["station"="light_rail"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});\n'
            f'  way["railway"="station"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});\n'
            ");\nout center tags;"
        )
        data = _overpass_raw(query)
        cache.write_text(json.dumps(data["elements"], ensure_ascii=False), encoding="utf-8")
    els = json.loads(cache.read_text(encoding="utf-8"))
    pts = []
    for e in els:
        if e["type"] == "node":
            pts.append((e["lon"], e["lat"]))
        elif "center" in e:
            pts.append((e["center"]["lon"], e["center"]["lat"]))
    return pts


def _near_rail(lon, lat, stations):
    return any(_haversine_m((lon, lat), s) <= NEAR_RAIL_M for s in stations)


def _pick_relation(relations, els):
    """Prefer the direction with more mapped way segments (the fuller variant);
    ties broken by lower relation id for determinism."""
    by_way_count = sorted(
        relations,
        key=lambda r: (-sum(1 for m in r["members"] if m["type"] == "way"), r["id"]),
    )
    chosen = by_way_count[0]
    ways = {e["id"]: e for e in els if e["type"] == "way"}
    nodes = {e["id"]: e for e in els if e["type"] == "node"}
    return chosen, ways, nodes


def _route_display_name(relation):
    name = relation.get("tags", {}).get("name", "")
    m = re.match(r"^\s*Трамвай\s+\d+\s*:\s*(.+?)\s*=>\s*(.+?)\s*$", name)
    if m:
        return f"{m.group(1)} - {m.group(2)}"
    frm, to = relation.get("tags", {}).get("from"), relation.get("tags", {}).get("to")
    if frm and to:
        return f"{frm} - {to}"
    return name or "?"


def _stitch_geometry(relation, ways, gap_tolerance_m=150):
    """Concatenate the relation's way members (in member order) into one or more
    continuous [lon, lat] lines, flipping a way when that orients it correctly.
    Real, unavoidable small gaps in the OSM mapping (a missing connector, a
    depot spur) start a new line instead of drawing a straight jump."""
    lines = []
    current = None
    for m in relation["members"]:
        if m["type"] != "way" or m["role"] not in ("", "forward", "backward"):
            continue
        way = ways.get(m["ref"])
        if not way or not way.get("geometry"):
            continue
        pts = [[p["lon"], p["lat"]] for p in way["geometry"] if p is not None]
        if len(pts) < 2:
            continue
        if current is None:
            current = pts
            continue
        end = tuple(current[-1])
        d_start = _haversine_m(end, tuple(pts[0]))
        d_end = _haversine_m(end, tuple(pts[-1]))
        if d_start <= d_end and d_start <= gap_tolerance_m:
            current.extend(pts[1:] if pts[0] == current[-1] else pts)
        elif d_end <= gap_tolerance_m:
            rev = list(reversed(pts))
            current.extend(rev[1:] if rev[0] == current[-1] else rev)
        else:
            lines.append(current)
            current = pts
    if current:
        lines.append(current)
    return lines


def _osm_stops(relation, ways, nodes):
    """Ordered, de-duplicated stop positions straight from the PTv2 relation
    member order (that order IS the travel order - the whole point of a route
    relation). Falls back to platform-role members if a relation has no
    stop-position nodes at all (not needed for any of our 10 routes, kept for
    robustness)."""
    def collect(roles):
        seen = None
        out = []
        for m in relation["members"]:
            if m["type"] == "node" and m["role"] in roles:
                node = nodes.get(m["ref"])
                if node is None or node["id"] == seen:
                    continue
                seen = node["id"]
                out.append(node)
        return out

    stops = collect(STOP_ROLES)
    if not stops:
        stops = collect(PLATFORM_ROLES)
    out = []
    for node in stops:
        out.append({
            "stop_id": str(node["id"]),
            "name": node.get("tags", {}).get("name") or "",
            "lat": node["lat"],
            "lon": node["lon"],
        })
    return out


# --- organizers' workbook (routes 1, 5, 7, 11, 12) ---------------------------

WB_HEADER = [
    "route_id", "route_short_name", "reg_num", "route_type", "trip_id", "trip_short_name",
    "direction_id", "start_date", "end_date", "stop_sequence", "stop_id", "actual_date",
    "stop_mode", "is_addpoint", "stop_name", "stop_lat", "stop_lon",
]


def _workbook_stops_and_names():
    import openpyxl
    wb = openpyxl.load_workbook(WORKBOOK, read_only=True, data_only=True)
    idx = {c: i for i, c in enumerate(WB_HEADER)}

    routes_sheet = wb["Маршруты GTFS_ROUTES"]
    names = {}
    for row in routes_sheet.iter_rows(min_row=3, values_only=True):
        if row[2]:
            names[int(row[2])] = row[3]

    order_sheet = wb["Порядок_с_координатами"]
    by_route = defaultdict(list)
    for row in order_sheet.iter_rows(min_row=2, values_only=True):
        by_route[row[idx["route_short_name"]]].append(row)

    stops_by_route = {}
    for route in WORKBOOK_ROUTES:
        rows = by_route.get(str(route), [])
        trips = defaultdict(list)
        for row in rows:
            trips[(row[idx["direction_id"]], row[idx["trip_id"]])].append(row)
        # fullest variant wins (some trip_ids are short-turn partial runs);
        # direction '0' breaks ties so the choice is stable across reruns.
        best = max(trips.values(), key=lambda v: (len(v), v[0][idx["direction_id"]] == "0"))
        best.sort(key=lambda row: int(row[idx["stop_sequence"]]))
        stops_by_route[route] = [
            {
                "stop_id": str(row[idx["stop_id"]]),
                "name": row[idx["stop_name"]],
                "lat": float(row[idx["stop_lat"]]),
                "lon": float(row[idx["stop_lon"]]),
            }
            for row in best
        ]
    return stops_by_route, names


def build_routes():
    stations = _fetch_stations()
    wb_stops, wb_names = _workbook_stops_and_names()
    rel_by_route = _fetch_route_relations()

    routes_out = []
    for route in cfg.ROUTES:
        relations = rel_by_route[route]
        els = rel_by_route[f"{route}_els"]

        if not relations:
            raise RuntimeError(f"no OSM route=tram relation found for ref={route}")
        chosen, ways, nodes = _pick_relation(relations, els)
        geometry = _stitch_geometry(chosen, ways)

        if route in WORKBOOK_ROUTES:
            stops = wb_stops[route]
            name = wb_names.get(route) or _route_display_name(chosen)
            source = "organizers+osm"
        else:
            stops = _osm_stops(chosen, ways, nodes)
            name = _route_display_name(chosen)
            source = "osm"

        n = len(stops)
        for i, s in enumerate(stops):
            s["seq"] = i + 1
            s["terminal"] = i == 0 or i == n - 1
            s["near_rail"] = _near_rail(s["lon"], s["lat"], stations)

        routes_out.append({
            "route": route,
            "name": name,
            "color": ROUTE_COLORS[route],
            "geometry": geometry,
            "stops": stops,
            "source": source,
        })
        print(f"route {route:>2}: {n} stops ({source}), "
              f"{sum(len(l) for l in geometry)} geometry points in {len(geometry)} line(s), "
              f"{sum(s['near_rail'] for s in stops)} near rail")

    cfg.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    with open(cfg.ARTIFACTS_DIR / "routes.json", "w", encoding="utf-8") as f:
        json.dump({"routes": routes_out}, f, ensure_ascii=False)
    return routes_out


# --- geo-binding: stop_shares.csv --------------------------------------------

# a tram is idle at a terminus between two directional runs for a few minutes
# up to a genuine break; a gap this long between two validations of the SAME
# garage_number+bus_exit_no is treated as "the vehicle turned around, start a
# new run" rather than "just a quiet stretch of the same run". Chosen from the
# actual inter-validation gap distribution (see printed sanity stats) rather
# than picked blind - it sits well past the bulk of in-run gaps and well before
# the long midday/overnight idle tail.
LAYOVER_GAP_MIN = 25


def _stop_id_lookup(routes):
    return {r["route"]: [s["stop_id"] for s in r["stops"]] for r in routes}


def _near_rail_positions(routes):
    """1-based seq positions of near_rail stops, per route (0-based index list)."""
    out = {}
    for r in routes:
        idxs = [s["seq"] - 1 for s in r["stops"] if s["near_rail"]]
        out[r["route"]] = idxs
    return out


def build_stop_shares(routes):
    # September-October only (see ingest.py) - no GPS at all in the raw data, so
    # the per-hour stop split is estimated from two representative months rather
    # than the full 10, which keeps this within the memory budget and is enough:
    # the split is a share of an *hour*, not of a date, and route schedules do not
    # change across the history.
    events_path = cfg.PROCESSED_DIR / "vehicle_events_TEST.parquet"
    stop_ids = _stop_id_lookup(routes)
    near_rail_idx = _near_rail_positions(routes)

    tmp_dir = cfg.PROCESSED_DIR / "duckdb_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET threads TO 4")
    con.execute("SET memory_limit = '1200MB'")
    con.execute("SET preserve_insertion_order = false")
    con.execute(f"SET temp_directory = '{str(tmp_dir).replace(chr(92), '/')}'")

    n_stops_values = ", ".join(f"({r},{len(stop_ids[r])})" for r in cfg.ROUTES)
    con.execute(f"CREATE OR REPLACE TEMP TABLE route_len AS "
                f"SELECT * FROM (VALUES {n_stops_values}) AS t(route, n_stops)")

    # sanity check on the gap distribution the layover threshold above rests on
    gaps = con.execute(f"""
        WITH g AS (
            SELECT date_diff('minute', lag(ts) OVER w, ts) AS gap_min
            FROM read_parquet('{events_path}')
            WINDOW w AS (PARTITION BY route, garage_number, bus_exit_no ORDER BY ts)
        )
        SELECT count(*) FILTER (WHERE gap_min IS NOT NULL AND gap_min BETWEEN 0 AND 500) AS n,
               median(gap_min) FILTER (WHERE gap_min BETWEEN 0 AND 500) AS median_gap,
               quantile_cont(gap_min, 0.90) FILTER (WHERE gap_min BETWEEN 0 AND 500) AS p90_gap,
               count(*) FILTER (WHERE gap_min > {LAYOVER_GAP_MIN} AND gap_min <= 500) AS n_over_threshold
        FROM g
    """).fetchone()
    print(f"inter-validation gaps (same vehicle+duty): median={gaps[1]:.1f} min, "
          f"p90={gaps[2]:.1f} min, {gaps[3]:,}/{gaps[0]:,} above the {LAYOVER_GAP_MIN}-min "
          f"layover threshold (these start a new run)")

    weighted = con.execute(f"""
        WITH runs AS (
            SELECT route, hour(ts) AS hour, is_transfer,
                   sum(CASE WHEN gap_min IS NULL OR gap_min > {LAYOVER_GAP_MIN} THEN 1 ELSE 0 END)
                       OVER (PARTITION BY route, garage_number, bus_exit_no ORDER BY ts) AS run_id,
                   route || '|' || garage_number || '|' || bus_exit_no AS veh, ts
            FROM (
                SELECT *, date_diff('minute', lag(ts) OVER w, ts) AS gap_min
                FROM read_parquet('{events_path}')
                WINDOW w AS (PARTITION BY route, garage_number, bus_exit_no ORDER BY ts)
            )
        ),
        spans AS (
            SELECT route, hour, is_transfer, veh, run_id, ts,
                   min(ts) OVER (PARTITION BY veh, run_id) AS run_start,
                   max(ts) OVER (PARTITION BY veh, run_id) AS run_end
            FROM runs
        ),
        shared AS (
            SELECT route, hour, is_transfer,
                   CASE WHEN run_end > run_start
                        THEN epoch(ts - run_start)::DOUBLE / epoch(run_end - run_start)
                        ELSE 0.5 END AS share_in_run,
                   n_stops
            FROM spans JOIN route_len USING (route)
        )
        SELECT route, hour, is_transfer,
               greatest(0, least(n_stops - 1, round(share_in_run * (n_stops - 1))))::INTEGER AS idx_fwd,
               greatest(0, least(n_stops - 1, round((1 - share_in_run) * (n_stops - 1))))::INTEGER AS idx_bwd,
               count(*)::DOUBLE AS n
        FROM shared
        GROUP BY 1, 2, 3, 4, 5
    """).fetchdf()

    raw = defaultdict(float)  # (route, hour, stop_idx) -> weight
    for row in weighted.itertuples(index=False):
        route, hour, is_transfer, idx_fwd, idx_bwd, n = row
        if route == 5:
            continue  # route 5: uniform, see below - it has ~no real boardings to bind
        if is_transfer:
            positions = near_rail_idx.get(route) or list(range(len(stop_ids[route])))
            for p in positions:
                raw[(route, hour, p)] += n / len(positions)
        else:
            raw[(route, hour, idx_fwd)] += n * 0.5
            raw[(route, hour, idx_bwd)] += n * 0.5

    totals = defaultdict(float)
    for (route, hour, _idx), w in raw.items():
        totals[(route, hour)] += w

    lines = ["route,stop_id,hour,share\n"]
    n_uniform_fallback = 0
    for route in cfg.ROUTES:
        ids = stop_ids[route]
        n = len(ids)
        for hour in range(24):
            total = totals.get((route, hour), 0.0)
            if route == 5 or total <= 0:
                if route != 5:
                    n_uniform_fallback += 1
                share = 1.0 / n
                for stop_id in ids:
                    lines.append(f"{route},{stop_id},{hour},{share:.6f}\n")
                continue
            row_shares = [raw.get((route, hour, i), 0.0) / total for i in range(n)]
            # rounding can leave the row a hair off 1 - push the remainder onto
            # the busiest stop of the hour so the contract's "sums to 1" holds exactly
            row_shares = [round(s, 6) for s in row_shares]
            diff = round(1.0 - sum(row_shares), 6)
            if diff:
                busiest = max(range(n), key=lambda i: row_shares[i])
                row_shares[busiest] = round(row_shares[busiest] + diff, 6)
            for stop_id, share in zip(ids, row_shares):
                lines.append(f"{route},{stop_id},{hour},{share:.6f}\n")

    with open(cfg.ARTIFACTS_DIR / "stop_shares.csv", "w", encoding="utf-8", newline="") as f:
        f.writelines(lines)
    print(f"wrote stop_shares.csv: {len(lines) - 1:,} rows, "
          f"{n_uniform_fallback} route/hour cells fell back to uniform (no data), "
          f"route 5 always uniform")


def run():
    routes = build_routes()
    build_stop_shares(routes)


if __name__ == "__main__":
    run()
