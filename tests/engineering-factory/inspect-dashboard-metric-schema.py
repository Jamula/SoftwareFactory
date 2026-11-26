"""Read only SQLite schema metadata in one fresh, private synthetic dashboard run.
Never read application rows, export credentials, or claim metric receipt.
"""
import json
from pathlib import Path
import re
import sqlite3
import sys

IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")

def inspect(root):
    root = Path(root).resolve(strict=True)
    runs = root / "runs"
    if not runs.is_dir() or runs.is_symlink():
        raise ValueError("expected private run directory")
    candidates = []
    for run in runs.iterdir():
        if run.is_symlink():
            raise ValueError("unexpected link")
        if run.is_dir():
            candidates.append(run)
    if len(candidates) != 1:
        raise ValueError("expected exactly one isolated run")
    db = candidates[0] / "dashboard.db"
    if db.is_symlink() or not db.is_file():
        raise ValueError("expected dashboard database")
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=2) as conn:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("PRAGMA trusted_schema=OFF")
        names = conn.execute(
            "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 129"
        ).fetchall()
        if not names or len(names) > 128:
            raise ValueError("unexpected table count")
        schema = {}
        for (name,) in names:
            if not IDENTIFIER.fullmatch(name):
                raise ValueError("unexpected identifier")
            if not any(term in name.lower() for term in ("metric", "instrument", "dimension", "histogram", "resource", "scope", "attribute")):
                continue
            columns = conn.execute(
                "SELECT name, type FROM pragma_table_info(?) ORDER BY cid LIMIT 129", (name,)
            ).fetchall()
            if not columns or len(columns) > 128:
                raise ValueError("unexpected columns")
            clean = []
            for column, kind in columns:
                if not IDENTIFIER.fullmatch(column) or not re.fullmatch(r"[A-Za-z0-9_ () ,]{0,64}", kind):
                    raise ValueError("unexpected column definition")
                clean.append([column, kind])
            schema[name] = clean
        if not any("metric" in name.lower() for name in schema):
            raise ValueError("metric schema not observed")
        return {"tables": schema, "receiptVerified": False}

if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("expected root")
        print("Dashboard metric schema (metadata only): " + json.dumps(inspect(sys.argv[1]), sort_keys=True))
    except Exception:
        print("Dashboard metric schema discovery failed", file=sys.stderr)
        sys.exit(1)
