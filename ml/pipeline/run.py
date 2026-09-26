"""Whole pipeline in one command: raw validations -> history -> stops -> backtests -> forecast.

    python -m pipeline.run               # with the organizers' dataset.zip (downloaded if missing)
    python -m pipeline.run --no-ingest   # from the committed history and routes only
"""
import sys

from . import backtest, forecast


def main():
    if "--no-ingest" not in sys.argv:
        from . import geo, ingest
        if ingest.run() is None:
            sys.exit("Приём данных не удался, см. сообщения выше")
        geo.run()
    backtest.main()
    forecast.main()


if __name__ == "__main__":
    main()
