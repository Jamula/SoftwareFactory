"""Offline fail-closed tests for the runner-only Aspire dashboard verifier."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("verify-dashboard-api.py")
SPEC = importlib.util.spec_from_file_location("verify_dashboard_api", SCRIPT)
API = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(API)

FAKE_KEY = "A" * 64
TRACE = "1" * 32
SPAN = "2" * 16
OTHER_SPAN = "3" * 16
ENV = {
    "FACTORY_DASHBOARD_ORIGIN": "https://127.0.0.1:18888",
    "DASHBOARD__API__SECONDARYAPIKEY": FAKE_KEY,
    "FACTORY_DASHBOARD_CA": "synthetic-ca.pem",
}


class FakeResponse:
    def __init__(self, status, body=b""):
        self.status = status
        self.body = body

    def read(self, limit):
        return self.body[:limit]


class FakeConnection:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.closed = False

    def request(self, method, path, headers=None):
        self.requests.append((method, path, headers or {}))

    def getresponse(self):
        if not self.responses:
            raise AssertionError("unexpected dashboard request")
        return self.responses.pop(0)

    def close(self):
        self.closed = True


def json_response(value, status=200):
    import json
    return FakeResponse(status, json.dumps(value).encode("utf-8"))


def telemetry(signal, span_id=SPAN, service="softwarefactory-shadow", scope="softwarefactory"):
    if signal == "spans":
        group = {
            "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": service}}]},
            "scopeSpans": [{
                "scope": {"name": scope},
                "spans": [{"name": "factory.evaluate", "traceId": TRACE, "spanId": span_id}],
            }],
        }
        return {"data": {"resourceSpans": [group]}}
    group = {
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": service}}]},
        "scopeLogs": [{
            "scope": {"name": scope},
            "logRecords": [{
                "body": {"stringValue": "factory.stage.completed"},
                "traceId": TRACE,
                "spanId": span_id,
            }],
        }],
    }
    return {"data": {"resourceLogs": [group]}}


def valid_responses(log_span=SPAN):
    return [
        FakeResponse(401), FakeResponse(401),
        json_response(telemetry("spans")),
        json_response(telemetry("logs", log_span)),
    ]


class DashboardVerifierTests(unittest.TestCase):
    def configured_verify(self, responses):
        connection = FakeConnection(responses)
        with patch.dict(os.environ, ENV, clear=False), \
             patch.object(API.ssl, "create_default_context", return_value=object()), \
             patch.object(API.http.client, "HTTPSConnection", return_value=connection) as create:
            API.verify()
        return connection, create

    def test_success_uses_only_loopback_and_closes_connection(self):
        connection, create = self.configured_verify(valid_responses())
        create.assert_called_once()
        self.assertTrue(connection.closed)
        self.assertEqual([path for _, path, _ in connection.requests], [
            "/api/telemetry/spans",
            "/api/telemetry/logs",
            "/api/telemetry/spans?limit=200",
            "/api/telemetry/logs?limit=200",
        ])
        self.assertEqual(connection.requests[0][2], {})
        self.assertEqual(connection.requests[2][2], {"X-API-Key": FAKE_KEY})

    def test_invalid_origins_fail_before_tls_or_network(self):
        for origin in (
            "http://127.0.0.1:18888",
            "https://example.invalid:18888",
            "https://127.0.0.1:18888/path",
            "https://user@127.0.0.1:18888",
            "https://127.0.0.1",
        ):
            with self.subTest(origin=origin):
                env = {**ENV, "FACTORY_DASHBOARD_ORIGIN": origin}
                with patch.dict(os.environ, env, clear=False), \
                     patch.object(API.ssl, "create_default_context") as make_context, \
                     patch.object(API.http.client, "HTTPSConnection") as create:
                    with self.assertRaisesRegex(ValueError, "nonlocal origin"):
                        API.verify()
                make_context.assert_not_called()
                create.assert_not_called()

    def test_invalid_synthetic_keys_fail_before_network(self):
        for key in ("", "a" * 64, "G" * 64, "A" * 63, "A" * 65):
            with self.subTest(key_length=len(key)):
                env = {**ENV, "DASHBOARD__API__SECONDARYAPIKEY": key}
                with patch.dict(os.environ, env, clear=False), \
                     patch.object(API.ssl, "create_default_context") as make_context, \
                     patch.object(API.http.client, "HTTPSConnection") as create:
                    with self.assertRaisesRegex(ValueError, "invalid ephemeral key"):
                        API.verify()
                make_context.assert_not_called()
                create.assert_not_called()

    def test_unexpected_status_fails_closed_and_closes_connection(self):
        connection = FakeConnection([FakeResponse(500)])
        with patch.dict(os.environ, ENV, clear=False), \
             patch.object(API.ssl, "create_default_context", return_value=object()), \
             patch.object(API.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(ValueError, "unexpected API authentication or response"):
                API.verify()
        self.assertTrue(connection.closed)

    def test_authenticated_unexpected_status_fails_closed_and_closes_connection(self):
        connection = FakeConnection([FakeResponse(401), FakeResponse(401), FakeResponse(500)])
        with patch.dict(os.environ, ENV, clear=False), \
             patch.object(API.ssl, "create_default_context", return_value=object()), \
             patch.object(API.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(ValueError, "unexpected API authentication or response"):
                API.verify()
        self.assertTrue(connection.closed)

    def test_oversized_authenticated_body_fails_closed_and_closes_connection(self):
        connection = FakeConnection([
            FakeResponse(401), FakeResponse(401), FakeResponse(200, b"x" * 4_000_001),
        ])
        with patch.dict(os.environ, ENV, clear=False), \
             patch.object(API.ssl, "create_default_context", return_value=object()), \
             patch.object(API.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(ValueError, "oversized response"):
                API.verify()
        self.assertTrue(connection.closed)

    def test_malformed_json_fails_closed_and_closes_connection(self):
        connection = FakeConnection([
            FakeResponse(401), FakeResponse(401), FakeResponse(200, b"{"),
        ])
        with patch.dict(os.environ, ENV, clear=False), \
             patch.object(API.ssl, "create_default_context", return_value=object()), \
             patch.object(API.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaises(ValueError):
                API.verify()
        self.assertTrue(connection.closed)

    def test_missing_trace_log_correlation_fails_closed_and_closes_connection(self):
        connection = FakeConnection(valid_responses(OTHER_SPAN))
        with patch.dict(os.environ, ENV, clear=False), \
             patch.object(API.ssl, "create_default_context", return_value=object()), \
             patch.object(API.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(ValueError, "missing correlated telemetry"):
                API.verify()
        self.assertTrue(connection.closed)

    def test_rows_without_expected_service_scope_or_nonzero_ids_do_not_match(self):
        wrong_service = telemetry("spans", service="untrusted")
        wrong_scope = telemetry("spans", scope="other")
        zero_ids = telemetry("spans")
        zero_ids["data"]["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["traceId"] = "0" * 32
        self.assertEqual(API.pairs(wrong_service, "spans"), set())
        self.assertEqual(API.pairs(wrong_scope, "spans"), set())
        self.assertEqual(API.pairs(zero_ids, "spans"), set())

    def test_cli_returns_generic_failure_without_echoing_synthetic_key(self):
        env = os.environ.copy()
        env.update(ENV)
        env["FACTORY_DASHBOARD_ORIGIN"] = "https://remote.example.invalid:18888"
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(
            result.stderr,
            "Authenticated dashboard API trace/log verification failed\n",
        )
        self.assertNotIn(FAKE_KEY, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
