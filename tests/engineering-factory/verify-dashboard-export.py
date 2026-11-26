"""Runner-only assertion of actual dashboard readback; never print telemetry or secrets."""
import json
import sys
import zipfile

def records(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from records(item)
    elif isinstance(value, list):
        for item in value:
            yield from records(item)

def verify(archive):
    spans, logs = set(), set()
    with zipfile.ZipFile(archive) as data:
        for name in data.namelist():
            parts = name.split("/")
            if len(parts) < 2 or not name.endswith(".json") or parts[0] not in ("traces", "structuredlogs"):
                continue
            if data.getinfo(name).file_size > 4_000_000:
                raise ValueError("oversize")
            for item in records(json.loads(data.read(name))):
                trace, span = item.get("traceId"), item.get("spanId")
                if not isinstance(trace, str) or not isinstance(span, str) or not trace or not span:
                    continue
                pair = (trace, span)
                if parts[0] == "traces" and item.get("name") == "factory.evaluate":
                    spans.add(pair)
                if parts[0] == "structuredlogs" and item.get("body") == {"stringValue": "factory.stage.completed"}:
                    logs.add(pair)
    if not spans.intersection(logs):
        raise ValueError("correlated telemetry missing")

if __name__ == "__main__":
    try:
        verify(sys.argv[1])
    except Exception:
        print("Dashboard trace/log readback failed", file=sys.stderr)
        sys.exit(1)
    print("Dashboard stored synthetic trace and correlated structured log")
