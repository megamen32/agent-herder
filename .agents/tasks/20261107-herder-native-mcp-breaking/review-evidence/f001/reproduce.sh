#!/usr/bin/env bash
set -eu
repo=/home/roomhacker/.codex/worktrees/herder-v1-implementation/agent-herder
evidence=/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/review-evidence/f001
parent=4c893a4e20f49106a080aa4e190cc8a3bf4b5fa4
fixed=8c607d3c6328bd4080ec55d6a5f66801cb5f1484
tmp=$(mktemp -d "${TMPDIR:-/tmp}/herder-f001.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/red" "$tmp/green"
git -C "$repo" archive "$parent" | tar -x -C "$tmp/red"
git -C "$repo" archive "$fixed" | tar -x -C "$tmp/green"
python3 - "$tmp/red/crates/herder/src/domain/resource.rs" "$tmp/green/crates/herder/src/domain/resource.rs" <<'PY'
import pathlib, sys
red, green = map(pathlib.Path, sys.argv[1:])
source = green.read_text()
start = source.index('    #[test]\n    fn resource_scope_rejects_extra_fields_and_accepts_valid_json()')
end = source.index('    fn attachment(', start)
test = source[start:end]
old = red.read_text()
marker = '    fn attachment('
assert 'fn resource_scope_rejects_extra_fields_and_accepts_valid_json()' not in old
assert old.count(marker) == 1
red.write_text(old.replace(marker, test + marker, 1))
PY
for variant in red green; do
  set +e
  (cd "$tmp/$variant/crates/herder" && CARGO_TARGET_DIR="$tmp/target-$variant" cargo test resource_scope_rejects_extra_fields_and_accepts_valid_json -- --nocapture) >"$evidence/$variant.stdout" 2>"$evidence/$variant.stderr"
  result=$?
  set -e
  printf '%s\n' "$result" >"$evidence/$variant.exit-code"
done
