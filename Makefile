.PHONY: all demo backtest test clean
all: demo test
demo:
	python -m synth.generate
	python -m env.make_synthetic_env
	python -m pipeline.aggregate
	python -m pipeline.detect
backtest:
	python -m eval.backtest
test:
	pytest -q
clean:
	rm -f data/events.csv data/aggregated.csv data/alerts.json reports/metrics.json reports/backtest.md
