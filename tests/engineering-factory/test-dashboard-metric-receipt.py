import importlib.util
from pathlib import Path
import sqlite3
import unittest
from contextlib import closing

spec = importlib.util.spec_from_file_location("receipt", Path(__file__).with_name("verify-dashboard-metric-receipt.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def fixture(conn):
    conn.executescript("""
        CREATE TABLE telemetry_metric_instruments(instrument_id INTEGER,instrument_name TEXT,unit TEXT,aggregation_temporality INTEGER,is_monotonic INTEGER,resource_id INTEGER,scope_id INTEGER,instrument_type INTEGER);
        CREATE TABLE telemetry_resources(resource_id INTEGER,resource_name TEXT);
        CREATE TABLE telemetry_scopes(scope_id INTEGER,scope_name TEXT);
        CREATE TABLE telemetry_metric_dimensions(dimension_id INTEGER,instrument_id INTEGER);
        CREATE TABLE telemetry_metric_dimension_attributes(dimension_id INTEGER,ordinal INTEGER,attribute_key TEXT,attribute_value TEXT);
        CREATE TABLE telemetry_metric_points(dimension_id INTEGER,start_time_unix_nano INTEGER,end_time_unix_nano INTEGER,integer_value INTEGER,double_value REAL,histogram_sum REAL,histogram_count INTEGER,flags INTEGER,histogram_aggregation_start_unix_nano INTEGER,point_type INTEGER);
        INSERT INTO telemetry_resources VALUES(1,'softwarefactory-shadow');
        INSERT INTO telemetry_scopes VALUES(1,'softwarefactory');
        INSERT INTO telemetry_metric_instruments VALUES(1,'factory.stage.count','',2,1,1,1,2),(2,'factory.stage.duration','ms',2,NULL,1,1,3);
        INSERT INTO telemetry_metric_dimensions VALUES(1,1),(2,2);
        INSERT INTO telemetry_metric_points VALUES(1,100,200,1,NULL,NULL,NULL,0,NULL,2),(2,100,200,NULL,NULL,2.5,1,0,100,3);
    """)
    conn.executescript("ALTER TABLE telemetry_metric_points ADD COLUMN histogram_aggregation_id INTEGER; ALTER TABLE telemetry_metric_points ADD COLUMN bucket_counts BLOB; ALTER TABLE telemetry_metric_points ADD COLUMN explicit_bounds BLOB;")
    for dim in (1,2):
        conn.executemany("INSERT INTO telemetry_metric_dimension_attributes VALUES(?,?,?,?)",
            [(dim,i,k,v) for i,(k,v) in enumerate(module.LABELS.items())])

class Receipt(unittest.TestCase):
    def test_valid_and_repeated_snapshots(self):
        with closing(sqlite3.connect(":memory:")) as conn:
            fixture(conn)
            self.assertTrue(module.verify(conn))
            conn.execute("INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type) VALUES(1,100,300,1,NULL,NULL,NULL,0,NULL,2)")
            self.assertTrue(module.verify(conn))
    def test_rejects_missing_wrong_or_contradictory_evidence(self):
        for sql in [
            "DELETE FROM telemetry_metric_points WHERE dimension_id=2",
            "UPDATE telemetry_metric_instruments SET instrument_type=3 WHERE instrument_id=1",
            "UPDATE telemetry_metric_instruments SET instrument_type=NULL WHERE instrument_id=2",
            "UPDATE telemetry_metric_points SET point_type=2 WHERE dimension_id=2",
            "UPDATE telemetry_metric_points SET point_type=99 WHERE dimension_id=1",
            "UPDATE telemetry_metric_points SET histogram_aggregation_start_unix_nano=100 WHERE dimension_id=1",
            "UPDATE telemetry_metric_points SET histogram_aggregation_id=1 WHERE dimension_id=1",
            "UPDATE telemetry_metric_points SET bucket_counts=X'01' WHERE dimension_id=1",
            "UPDATE telemetry_metric_points SET explicit_bounds=X'01' WHERE dimension_id=1",
            "UPDATE telemetry_metric_points SET end_time_unix_nano=start_time_unix_nano WHERE dimension_id=1",
            "UPDATE telemetry_metric_points SET end_time_unix_nano=start_time_unix_nano WHERE dimension_id=2",
            "UPDATE telemetry_metric_points SET flags=1 WHERE dimension_id=1",
            "UPDATE telemetry_metric_instruments SET aggregation_temporality=1 WHERE instrument_id=2",
            "UPDATE telemetry_metric_points SET integer_value=2 WHERE dimension_id=1",
            "UPDATE telemetry_metric_points SET double_value=2 WHERE dimension_id=1",
            "UPDATE telemetry_metric_points SET histogram_count=2 WHERE dimension_id=2",
            "INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type) VALUES(2,100,300,NULL,NULL,8.5,1,0,100,3)",
            "UPDATE telemetry_metric_dimension_attributes SET attribute_value='eligible' WHERE attribute_key='outcome'",
            "UPDATE telemetry_resources SET resource_name='wrong'",
            "INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type) VALUES(1,201,300,1,NULL,NULL,NULL,0,NULL,2)",
            "INSERT INTO telemetry_metric_points(dimension_id,start_time_unix_nano,end_time_unix_nano,integer_value,double_value,histogram_sum,histogram_count,flags,histogram_aggregation_start_unix_nano,point_type) VALUES(2,201,300,NULL,NULL,2.5,1,0,201,3)",
        ]:
            with self.subTest(sql=sql), closing(sqlite3.connect(":memory:")) as conn:
                fixture(conn)
                conn.execute(sql)
                with self.assertRaises(ValueError):
                    module.verify(conn)

if __name__ == "__main__":
    unittest.main()
