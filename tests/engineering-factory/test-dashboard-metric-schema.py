import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("schema_probe", Path(__file__).with_name("inspect-dashboard-metric-schema.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SchemaProbe(unittest.TestCase):
    def test_reads_schema_without_rows_and_rejects_ambiguous_runs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            run = root / "runs" / "run-1"
            run.mkdir(parents=True)
            db = run / "dashboard.db"
            with sqlite3.connect(db) as conn:
                conn.execute("CREATE TABLE MetricPoints (Id INTEGER, Payload TEXT)")
                conn.execute("INSERT INTO MetricPoints VALUES (1, 'private-fixture-value')")
                conn.execute("CREATE TABLE Logs (Body TEXT)")
            result = module.inspect(root)
            self.assertFalse(result["receiptVerified"])
            self.assertEqual(result["tables"], {"MetricPoints": [["Id", "INTEGER"], ["Payload", "TEXT"]]})
            self.assertNotIn("private-fixture-value", repr(result))
            (root / "runs" / "run-2").mkdir()
            with self.assertRaises(ValueError):
                module.inspect(root)
    def test_missing_run_and_missing_metric_schema_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(ValueError):
                module.inspect(root)
            run = root / "runs" / "run-1"
            run.mkdir(parents=True)
            with sqlite3.connect(run / "dashboard.db") as conn:
                conn.execute("CREATE TABLE Logs (Body TEXT)")
            with self.assertRaises(ValueError):
                module.inspect(root)

if __name__ == "__main__":
    unittest.main()
