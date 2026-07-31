#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

required_files=(
  "AGENTS.md"
  "docs/tutor-sprint-1-design.md"
  "lib/tutor/course.ts"
  "lib/tutor/courses.ts"
  "lib/tutor/lessonCatalog.ts"
  "content/tutor-courses/day-01.ts"
  "app/tutor/90day/page.tsx"
  "components/Tutor90DayShell.tsx"
)

printf '\nTAOS Tutor Sprint 1 validation\n'
printf '%s\n' '--------------------------------'

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed or not on PATH." >&2
  exit 1
fi

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: required Tutor file is missing: $file" >&2
    exit 1
  fi
done

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo "Required Tutor files: present"

if [[ ! -d node_modules ]]; then
  echo "ERROR: node_modules is missing. Run npm install first." >&2
  exit 1
fi

run_gate() {
  local label="$1"
  shift
  printf '\n[%s]\n' "$label"
  "$@"
}

run_gate "TypeScript" npm run typecheck
run_gate "ESLint" npm run lint
run_gate "Vitest" npm test

if [[ "${TAOS_SKIP_BUILD:-0}" == "1" ]]; then
  printf '\n[Production build]\nSkipped because TAOS_SKIP_BUILD=1.\n'
else
  run_gate "Production build" npm run build
fi

printf '\nTAOS Tutor Sprint 1 validation passed.\n'
