from pathlib import Path
import os
import subprocess

path = "src/adapters/chatgpt-mac-cdp-driver.ts"
ref = os.environ.get("HERDER_SOURCE_REF")
if ref:
    source = subprocess.check_output(["git", "show", f"{ref}:{path}"], text=True)
    origin = ref
else:
    source = Path(path).read_text(encoding="utf-8")
    origin = "working-tree"

assert "setInterval" not in source, f"background prompt timer remains in {origin}"
assert "scanPromptOnce" in source, f"bounded scan missing in {origin}"
print(f"PASS: {origin} has no background prompt timer and has bounded scan")
