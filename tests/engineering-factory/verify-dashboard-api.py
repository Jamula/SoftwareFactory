"""Runner-only authenticated dashboard readback using an explicitly trusted local CA.
No root-store mutation, redirect, proxy, or raw telemetry/key output.
"""
import http.client
import json
import os
import re
import ssl
import sys
from urllib.parse import urlsplit

def read(conn, path, key=None):
    conn.request("GET", path, headers={} if key is None else {"X-API-Key": key})
    response = conn.getresponse()
    if response.status != (401 if key is None else 200):
        raise ValueError("unexpected API authentication or response")
    body = response.read(4_000_001)
    if len(body) > 4_000_000:
        raise ValueError("oversized response")
    return json.loads(body) if key is not None else None

def pairs(payload, signal):
    groups = payload["data"]["resourceSpans" if signal == "spans" else "resourceLogs"]
    result = set()
    for group in groups:
        attrs = group["resource"]["attributes"]
        if not any(a.get("key") == "service.name" and a.get("value") == {"stringValue": "softwarefactory-shadow"} for a in attrs):
            continue
        for scope in group["scopeSpans" if signal == "spans" else "scopeLogs"]:
            if scope.get("scope", {}).get("name") != "softwarefactory":
                continue
            for row in scope["spans" if signal == "spans" else "logRecords"]:
                if signal == "spans" and row.get("name") != "factory.evaluate":
                    continue
                if signal == "logs" and row.get("body") != {"stringValue": "factory.stage.completed"}:
                    continue
                trace, span = row.get("traceId"), row.get("spanId")
                if isinstance(trace, str) and isinstance(span, str) and re.fullmatch(r"[0-9a-fA-F]{32}", trace) and re.fullmatch(r"[0-9a-fA-F]{16}", span) and int(trace, 16) and int(span, 16):
                    result.add((trace.lower(), span.lower()))
    return result

def verify():
    origin = urlsplit(os.environ["FACTORY_DASHBOARD_ORIGIN"])
    if origin.scheme != "https" or origin.hostname not in ("localhost", "127.0.0.1", "::1") or not origin.port or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        raise ValueError("nonlocal origin")
    key = os.environ["DASHBOARD__API__SECONDARYAPIKEY"]
    if not re.fullmatch(r"[0-9A-F]{64}", key):
        raise ValueError("invalid ephemeral key")
    context = ssl.create_default_context(cafile=os.environ["FACTORY_DASHBOARD_CA"])
    conn = http.client.HTTPSConnection(origin.hostname, origin.port, context=context, timeout=5)
    try:
        for endpoint in ("spans", "logs"):
            read(conn, "/api/telemetry/" + endpoint)
        spans = pairs(read(conn, "/api/telemetry/spans?limit=200", key), "spans")
        logs = pairs(read(conn, "/api/telemetry/logs?limit=200", key), "logs")
        if not spans.intersection(logs):
            raise ValueError("missing correlated telemetry")
    finally:
        conn.close()

if __name__ == "__main__":
    try:
        verify()
    except Exception:
        print("Authenticated dashboard API trace/log verification failed", file=sys.stderr)
        sys.exit(1)
    print("Dashboard stored synthetic trace and correlated structured log")
