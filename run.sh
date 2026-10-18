#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PYTHON="${ROOT_DIR}/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
    PYTHON="python3"
fi

PYTEST="${ROOT_DIR}/.venv/bin/pytest"
if [[ ! -x "$PYTEST" ]]; then
    PYTEST="pytest"
fi

TARGET="${1:-all}"

case "$TARGET" in
    demo)
        "$PYTHON" -m synth.generate
        "$PYTHON" -m env.make_synthetic_env
        "$PYTHON" -m pipeline.aggregate
        "$PYTHON" -m pipeline.detect
        ;;
    backtest)
        "$PYTHON" -m eval.backtest
        ;;
    test)
        "$PYTEST" -q
        ;;
    clean)
        rm -f data/events.csv data/aggregated.csv data/alerts.json reports/metrics.json reports/backtest.md
        ;;
    all)
        "$PYTHON" -m synth.generate
        "$PYTHON" -m env.make_synthetic_env
        "$PYTHON" -m pipeline.aggregate
        "$PYTHON" -m pipeline.detect
        "$PYTEST" -q
        ;;
    *)
        echo "Unknown target: $TARGET. Usage: ./run.sh [all|demo|backtest|test|clean]" >&2
        exit 1
        ;;
esac
