"""Verify only fixed synthetic metrics in the Aspire 17 dashboard database.

Schema observed in hosted Linux run 45772134039, job 139747049167.
Read a fresh, private Run-mode database after authenticated runtime and clean stop.
No raw rows, arbitrary SQL, credentials, or database artifacts leave the runner.
"""
from contextlib import closing
import math
from pathlib import Path
import sqlite3
import sys

NAMES = ("factory.stage.count", "factory.stage.duration")
LABELS = {"stage": "evaluate", "outcome": "blocked", "reason": "POLICY"}

def bounded(conn, sql, args=(), limit=128):
    rows = conn.execute(sql, args).fetchmany(limit + 1)
    if len(rows) > limit:
        raise ValueError("unexpected result size")
    return rows

def verify(conn):
    instruments = bounded(conn, """
        SELECT i.instrument_id, i.instrument_name, i.unit, i.aggregation_temporality,
               i.is_monotonic, r.resource_name, s.scope_name
        FROM telemetry_metric_instruments i
        LEFT JOIN telemetry_resources r ON r.resource_id=i.resource_id
        LEFT JOIN telemetry_scopes s ON s.scope_id=i.scope_id
        WHERE i.instrument_name IN (?, ?)
        """, NAMES)
    if len(instruments) != 2 or {row[1] for row in instruments} != set(NAMES):
        raise ValueError("instrument identity")
    for instrument_id, name, unit, temporality, monotonic, resource, scope in instruments:
        if resource != "softwarefactory-shadow" or scope != "softwarefactory" or temporality != 2:
            raise ValueError("instrument provenance or temporality")
        counter = name == NAMES[0]
        if (counter and monotonic != 1) or (not counter and unit != "ms"):
            raise ValueError("instrument kind")
        dimensions = bounded(conn, """
            SELECT dimension_id FROM telemetry_metric_dimensions WHERE instrument_id=?
            """, (instrument_id,))
        if not dimensions:
            raise ValueError("missing dimension")
        period = None
        histogram_sum = None
        recorded_dimension = None
        for (dimension_id,) in dimensions:
            attrs = bounded(conn, """
                SELECT attribute_key, attribute_value FROM telemetry_metric_dimension_attributes
                WHERE dimension_id=? ORDER BY ordinal
                """, (dimension_id,))
            points = bounded(conn, """
                SELECT start_time_unix_nano, end_time_unix_nano, integer_value, double_value,
                       histogram_sum, histogram_count, flags, histogram_aggregation_start_unix_nano
                FROM telemetry_metric_points WHERE dimension_id=?
                """, (dimension_id,), limit=1024)
            for start, end, integer, double, total, count, flags, histogram_start in points:
                # Missing flags have the default zero value in OTLP.
                if flags is not None and (type(flags) is not int or not 0 <= flags <= 0xffffffff):
                    raise ValueError("invalid flags")
                if flags is not None and flags & 1:
                    continue
                if len(attrs) != len(LABELS) or dict(attrs) != LABELS:
                    raise ValueError("unexpected recorded labels")
                if recorded_dimension is not None and recorded_dimension != dimension_id:
                    raise ValueError("multiple recorded dimensions")
                recorded_dimension = dimension_id
                if type(start) is not int or type(end) is not int or not 0 < start <= end:
                    raise ValueError("invalid timestamps")
                if period is not None and period != start:
                    raise ValueError("multiple cumulative periods")
                period = start
                if counter:
                    if (integer is None) == (double is None):
                        raise ValueError("counter value fields")
                    if (integer is not None and (type(integer) is not int or integer != 1)) or (double is not None and (type(double) not in (float, int) or double != 1)):
                        raise ValueError("counter value")
                    if total is not None or count is not None:
                        raise ValueError("conflicting histogram fields")
                else:
                    if integer is not None or double is not None or type(count) is not int or count != 1:
                        raise ValueError("histogram count")
                    if type(total) not in (float, int) or not math.isfinite(total) or total < 0:
                        raise ValueError("histogram sum")
                    if histogram_sum is not None and total != histogram_sum:
                        raise ValueError("contradictory histogram sum")
                    histogram_sum = total
                    if histogram_start is not None and histogram_start != start:
                        raise ValueError("histogram aggregation period")
        if period is None:
            raise ValueError("missing recorded points")
    return True

def verify_run(root):
    root = Path(root).resolve(strict=True)
    runs = root / "runs"
    if not runs.is_dir() or runs.is_symlink():
        raise ValueError("missing run root")
    children = list(runs.iterdir())
    if any(p.is_symlink() for p in children):
        raise ValueError("unexpected run link")
    directories = [p for p in children if p.is_dir()]
    if len(directories) != 1:
        raise ValueError("ambiguous run")
    db = directories[0] / "dashboard.db"
    if db.is_symlink() or not db.is_file():
        raise ValueError("missing database")
    with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=2)) as conn:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("PRAGMA trusted_schema=OFF")
        result = verify(conn)
        # Temporary schema-encoding evidence, restricted to fixed synthetic
        # instruments. Only small integer discriminators are emitted.
        types = bounded(conn, """
            SELECT DISTINCT i.instrument_name, i.instrument_type, p.point_type
            FROM telemetry_metric_instruments i
            JOIN telemetry_metric_dimensions d ON d.instrument_id=i.instrument_id
            JOIN telemetry_metric_points p ON p.dimension_id=d.dimension_id
            WHERE i.instrument_name IN (?, ?) AND (COALESCE(p.flags,0) & 1)=0
            ORDER BY i.instrument_name, i.instrument_type, p.point_type
            """, NAMES, limit=8)
        if not types or any(name not in NAMES or type(kind) is not int or
                            type(point) is not int or not 0 <= kind <= 255 or
                            not 0 <= point <= 255 for name, kind, point in types):
            raise ValueError("unknown discriminator encoding")
        for name, kind, point in types:
            print(f"Metric type encoding: {name} instrument={kind} point={point}")
        return result

if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("expected root")
        verify_run(sys.argv[1])
        print("Dashboard persisted synthetic cumulative counter and histogram: verified")
    except Exception:
        print("Dashboard metric persistence verification failed", file=sys.stderr)
        sys.exit(1)
