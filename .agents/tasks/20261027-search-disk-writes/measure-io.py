"""Read-only process/thread I/O and search-index progress, output one receipt."""
import argparse
import json
from pathlib import Path
import sqlite3
import time

parser = argparse.ArgumentParser()
parser.add_argument("pid", type=int)
parser.add_argument("--seconds", type=int, default=75)
args = parser.parse_args()
proc = Path("/proc") / str(args.pid)
database = Path.home() / ".local/state/agent-herder/session-search/index.sqlite"
connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=0.1)
connection.execute("PRAGMA query_only=ON")

def io(path):
    try:
        return {key: int(value) for key, value in
                (line.split(":", 1) for line in path.read_text().splitlines())}
    except (OSError, ValueError):
        return {}

def snapshot():
    threads = {}
    for directory in (proc / "task").iterdir():
        threads[directory.name] = io(directory / "io")
    try:
        row = connection.execute("SELECT status,updated_at,processed,error,scan_id FROM search_run WHERE id=1").fetchone()
        counts = dict(connection.execute("SELECT name,n FROM search_counts"))
        search = {"run": row, "counts": counts}
    except sqlite3.Error as error:
        search = {"read_error": str(error)}
    return {"time": time.time(), "io": io(proc / "io"), "threads": threads,
            "search": search, "wal_size": Path(str(database) + "-wal").stat().st_size}

first = snapshot()
static_rows = list(connection.execute("SELECT harness,native_id,revision,generation,scan FROM sessions ORDER BY harness,native_id LIMIT 128"))
rows = [first]
for _ in range(args.seconds):
    time.sleep(1)
    rows.append(snapshot())
last = rows[-1]
result = {"pid": args.pid, "seconds": last["time"] - first["time"],
          "static_rows_before": static_rows,
          "static_rows_after": list(connection.execute("SELECT harness,native_id,revision,generation,scan FROM sessions ORDER BY harness,native_id LIMIT 128")),
          "io_delta": {key: last["io"].get(key, 0) - value for key, value in first["io"].items()},
          "threads": sorted(({"tid": tid, "write_bytes": values.get("write_bytes", 0) - first["threads"].get(tid, {}).get("write_bytes", 0)}
                             for tid, values in last["threads"].items()), key=lambda x: x["write_bytes"], reverse=True),
          "samples": [{"time": row["time"], "write_bytes": row["io"].get("write_bytes"),
                       "read_bytes": row["io"].get("read_bytes"), "rchar": row["io"].get("rchar"),
                       "wal_size": row["wal_size"], "search": row["search"]} for row in rows]}
connection.close()
print(json.dumps(result))
