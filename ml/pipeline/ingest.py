"""Ingestion and normalization of the organizers' raw tram validation dumps.

Produces:
  ml/data/processed/hourly.parquet          - boardings per (route, date, hour),
                                               plus unique riders, metro/rail transfer
                                               share and a coarse ticket-type mix.
                                               Built from train.csv + test.csv (the
                                               full 10-month history the contract's
                                               history_hourly.csv needs).
  ml/data/processed/vehicle_events_TEST.parquet - one row per accepted validation,
                                               September-October only, with just what
                                               geo.py needs to bind stops (route,
                                               vehicle, timestamp, transfer flag). Two
                                               months of the same weekly pattern are
                                               enough to estimate an hour's stop split;
                                               restricting this export to test.csv means
                                               train.csv's rows never have to be held or
                                               sorted per vehicle at all.

Run: python -m pipeline.ingest   (from ml/, or `python ml/pipeline/ingest.py` from repo root)
"""
import datetime
import sys
import time

import duckdb

from . import config as cfg

RAW_COLUMNS = (
    "tran_no device_no tran_date_time begin_date_time input_date_time crd_hashcode "
    "validation_result tran_type_id place_id good_type pass_route ngpt_route "
    "bus_exit_no garage_number"
).split()

# duckdb's parallel CSV reader chokes on these files (organizers' export quirk) -
# header/quote/escape must be disabled explicitly and reading kept single-threaded.
def _read_csv_sql(path):
    cols = "{" + ", ".join(f"'{c}': 'VARCHAR'" for c in RAW_COLUMNS) + "}"
    p = str(path).replace("'", "''")
    return (
        f"read_csv('{p}', delim=';', header=true, quote='', escape='', "
        f"auto_detect=false, columns={cols}, parallel=false, strict_mode=false)"
    )


# good_type is a free-text tariff label; bucket the frequent ones, keep the rest as "other".
GOOD_TYPE_CASE = """
    CASE
        WHEN good_type = 'КОШЕЛЕК' THEN 'wallet'
        WHEN good_type LIKE 'СКМ%' OR good_type LIKE 'ББК%' OR good_type LIKE 'СКМО%'
             OR good_type LIKE 'БСК%' OR good_type LIKE 'СК ГУВД%' THEN 'social'
        WHEN good_type LIKE '30%' THEN 'pass30'
        WHEN good_type LIKE '90%' THEN 'pass90'
        WHEN good_type LIKE '365%' THEN 'pass365'
        ELSE 'other'
    END
"""

# pass_route is a noisy dot-separated chain of transport legs the passenger used
# before this tap (e.g. "Мосметро.НГПТ" = metro then this tram). We take the leg
# right before the trailing "НГПТ" (this tram tap); if the field does not end in
# "НГПТ" we fall back to its last leg. A rail-family leg there (Мосметро/МЦК/МЦД*/ЖД*)
# marks this boarding as a transfer from metro/MCC/MCD.
# The field is plain SQL NULL (not an empty string) for a large minority of taps
# (~44% in test.csv) - it is simply not logged for them, regardless of tariff or
# route. There is no way to tell whether those were transfers, so they are counted
# as not a transfer (IS_TRANSFER_SQL below coalesces to false) - the conservative
# reading, and consistent with "НГПТ" alone (a chain with no prior leg at all).
PREV_LEG_SQL = """
    WITH legs AS (
        SELECT string_split(regexp_replace(trim(pass_route), '\\s*\\.\\s*', '.', 'g'), '.') AS l
    )
    SELECT CASE
        WHEN len(l) = 0 OR l[len(l)] = '' THEN NULL
        WHEN l[len(l)] = 'НГПТ' AND len(l) >= 2 THEN l[len(l) - 1]
        ELSE l[len(l)]
    END
    FROM legs
"""
IS_TRANSFER_SQL = f"""
    COALESCE(
        ({PREV_LEG_SQL}) IN ('Мосметро', 'МЦК')
        OR ({PREV_LEG_SQL}) LIKE 'МЦД%'
        OR ({PREV_LEG_SQL}) LIKE 'ЖД%',
        false
    )
"""


def _normalized_view(con, name, csv_path, date_from, date_to):
    """Register a view with one row per accepted (validation_result='1') tram tap,
    clipped to date_from..date_to (see config.py for why the bounds are not a
    plain Jan-Aug/Sep-Oct split)."""
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW {name} AS
        SELECT
            CAST(regexp_extract(ngpt_route, '^([0-9]+)', 1) AS INTEGER) AS route,
            CAST(strptime(tran_date_time, '%Y-%m-%d %H:%M:%S') AS DATE) AS date,
            hour(strptime(tran_date_time, '%Y-%m-%d %H:%M:%S')) AS hour,
            strptime(tran_date_time, '%Y-%m-%d %H:%M:%S') AS ts,
            crd_hashcode,
            garage_number,
            bus_exit_no,
            {GOOD_TYPE_CASE} AS good_type_bucket,
            ({IS_TRANSFER_SQL}) AS is_transfer
        FROM {_read_csv_sql(csv_path)}
        WHERE validation_result = '1'
          AND CAST(strptime(tran_date_time, '%Y-%m-%d %H:%M:%S') AS DATE)
              BETWEEN DATE '{date_from}' AND DATE '{date_to}'
    """)


def _hourly_agg_sql(name):
    return f"""
        SELECT
            route, date, hour,
            count(*) AS boardings,
            count(DISTINCT crd_hashcode) AS unique_cards,
            sum(is_transfer::INT) AS metro_transfers,
            sum((good_type_bucket = 'wallet')::INT) AS n_wallet,
            sum((good_type_bucket = 'social')::INT) AS n_social,
            sum((good_type_bucket = 'pass30')::INT) AS n_pass30,
            sum((good_type_bucket = 'pass90')::INT) AS n_pass90,
            sum((good_type_bucket = 'pass365')::INT) AS n_pass365,
            sum((good_type_bucket = 'other')::INT) AS n_other
        FROM {name}
        GROUP BY 1, 2, 3
    """


def run():
    cfg.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    train_csv = cfg.extract_from_dataset("train.csv", cfg.RAW_DIR)
    test_csv = cfg.extract_from_dataset("test.csv", cfg.RAW_DIR)

    # train.csv/test.csv together are ~10 GB; keep everything disk-bound and capped,
    # never let duckdb (or pandas) try to hold the raw rows in RAM.
    tmp_dir = cfg.PROCESSED_DIR / "duckdb_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET threads TO 4")
    con.execute("SET memory_limit = '1200MB'")
    # the hourly group-by's hash table build spiked past a lower cap on a real run;
    # insertion order is never relied on (everything gets an explicit ORDER BY),
    # so let duckdb reuse memory instead of holding row order.
    con.execute("SET preserve_insertion_order = false")
    con.execute(f"SET temp_directory = '{str(tmp_dir).replace(chr(92), '/')}'")

    t0 = time.time()
    _normalized_view(con, "train_ok", train_csv, *cfg.TRAIN_CSV_RANGE)
    _normalized_view(con, "test_ok", test_csv, *cfg.TEST_CSV_RANGE)
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW all_ok AS
        SELECT * FROM train_ok UNION ALL BY NAME SELECT * FROM test_ok
    """)

    hourly_sql = f"""
        WITH h AS ({_hourly_agg_sql("all_ok")})
        SELECT route, date, hour, boardings, unique_cards, metro_transfers,
               round(n_wallet::DOUBLE / boardings, 4) AS share_wallet,
               round(n_social::DOUBLE / boardings, 4) AS share_social,
               round(n_pass30::DOUBLE / boardings, 4) AS share_pass30,
               round(n_pass90::DOUBLE / boardings, 4) AS share_pass90,
               round(n_pass365::DOUBLE / boardings, 4) AS share_pass365,
               round(n_other::DOUBLE / boardings, 4) AS share_other
        FROM h
        ORDER BY route, date, hour
    """
    con.execute(f"CREATE OR REPLACE TEMP TABLE hourly_agg AS {hourly_sql}")
    out_hourly = cfg.PROCESSED_DIR / "hourly.parquet"
    con.execute(f"COPY hourly_agg TO '{out_hourly}' (FORMAT PARQUET)")
    hourly = con.execute("SELECT * FROM hourly_agg").df()
    print(f"aggregated {len(hourly):,} route/date/hour rows in {time.time() - t0:.0f}s")

    # full route x date x hour grid with zeros - contract's history_hourly.csv
    routes_list = ", ".join(str(r) for r in cfg.ROUTES)
    date_from, date_to = cfg.HISTORY_RANGE
    grid_sql = f"""
        COPY (
            SELECT g.route, strftime(g.date, '%Y-%m-%d') AS date, g.hour, COALESCE(h.boardings, 0)::INTEGER AS boardings
            FROM (
                SELECT r AS route, d AS date, hr AS hour
                FROM unnest([{routes_list}]) AS t1(r)
                CROSS JOIN unnest(generate_series(DATE '{date_from}', DATE '{date_to}', INTERVAL 1 DAY)) AS t2(d)
                CROSS JOIN unnest(generate_series(0, 23)) AS t3(hr)
            ) g
            LEFT JOIN hourly_agg h USING (route, date, hour)
            ORDER BY g.route, g.date, g.hour
        ) TO '{cfg.ARTIFACTS_DIR / "history_hourly.csv"}' (HEADER, DELIMITER ',')
    """
    cfg.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    con.execute(grid_sql)
    n_days = (datetime.date.fromisoformat(date_to) - datetime.date.fromisoformat(date_from)).days + 1
    n_grid = len(cfg.ROUTES) * n_days * 24
    print(f"wrote history_hourly.csv: {n_grid:,} rows (full grid, zeros kept)")

    # geo-binding only needs test.csv (Sep-Oct): two months carry the same weekly
    # boarding pattern, and skipping train_ok here keeps the run-detection window
    # function in geo.py from ever sorting 8 months of extra rows per vehicle.
    events_path = cfg.PROCESSED_DIR / "vehicle_events_TEST.parquet"
    con.execute(f"""
        COPY (
            SELECT route, garage_number, bus_exit_no, ts, is_transfer
            FROM test_ok
            ORDER BY route, garage_number, bus_exit_no, ts
        ) TO '{events_path}' (FORMAT PARQUET)
    """)
    n_events = con.execute(f"SELECT count(*) FROM read_parquet('{events_path}')").fetchone()[0]
    print(f"wrote {n_events:,} vehicle events (test.csv only) for geo-binding")

    _verify_against_labels(con, hourly)
    return hourly


def _verify_against_labels(con, hourly):
    """Aggregation must match the organizers' own labels exactly (README's target definition)."""
    train_lab = cfg.extract_from_dataset("labels/labels_day_train.csv", cfg.RAW_DIR)
    test_lab = cfg.extract_from_dataset("labels/labels_day_test.csv", cfg.RAW_DIR)
    labels = con.execute(f"""
        SELECT route, CAST(date AS DATE) AS date, hour, boardings FROM read_csv_auto('{train_lab}', delim=';')
        UNION ALL
        SELECT route, CAST(date AS DATE) AS date, hour, boardings FROM read_csv_auto('{test_lab}', delim=';')
    """).df()
    left = hourly[["route", "date", "hour", "boardings"]]
    merged = labels.merge(left, on=["route", "date", "hour"], how="outer",
                           suffixes=("_label", "_ours"), indicator=True)
    mismatched = merged[merged["_merge"] == "both"]
    mismatched = mismatched[mismatched.boardings_label != mismatched.boardings_ours]
    only_ours = (merged["_merge"] == "right_only").sum()
    only_label = (merged["_merge"] == "left_only").sum()
    assert len(mismatched) == 0, f"{len(mismatched)} route/date/hour cells disagree with organizers' labels"
    assert labels.boardings.sum() == left.boardings.sum(), "totals do not match organizers' labels"
    print(f"CHECK OK: {len(labels):,} label cells match exactly "
          f"(sum={int(labels.boardings.sum()):,}); "
          f"{only_ours} cells only in our aggregation, {only_label} only in labels "
          f"(both are calendar-edge cells outside the file's own month, expected).")


if __name__ == "__main__":
    sys.exit(0 if run() is not None else 1)
