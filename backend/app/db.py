"""SQLite store shared by the web app and the background worker (WAL mode, safe for concurrent readers + one writer).

Integrity rules are enforced by the database itself, not by convention:
  * ``forecasts`` rows can never be updated or deleted (triggers abort the statement).
  * ``outcomes`` rows are write-once: a forecast is scored exactly once, against the data that exists when it matures.
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS spot_ticks (
  ts REAL PRIMARY KEY,            -- provider's own update time (epoch seconds)
  price REAL NOT NULL,
  retrieved REAL NOT NULL         -- when this app fetched it
);

CREATE TABLE IF NOT EXISTS forecasts (
  id TEXT PRIMARY KEY,            -- deterministic: task|role|version|base|target (re-issuing the same forecast is a no-op)
  task TEXT NOT NULL,             -- nowcast | fwd_1 | fwd_5 | fwd_20
  instrument TEXT NOT NULL,       -- futures (GC=F)
  target_def TEXT NOT NULL,       -- exact definition of what is being predicted
  role TEXT NOT NULL,             -- champion | shadow | baseline
  model_version TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  feature_schema TEXT NOT NULL,
  issued_at REAL NOT NULL,
  input_cutoff REAL NOT NULL,     -- epoch seconds: no input newer than this was used
  base_price REAL NOT NULL,
  base_time TEXT NOT NULL,        -- date (daily tasks) or ISO time (nowcast) of the base price
  target_date TEXT NOT NULL,      -- session date whose official close is the target
  target_time TEXT NOT NULL,      -- ISO time with timezone of the target moment
  horizon INTEGER,
  predicted REAL NOT NULL,
  low REAL, high REAL, level REAL,
  data_key TEXT,
  hours_left REAL
);
CREATE INDEX IF NOT EXISTS ix_forecasts_task_target ON forecasts(task, target_date);
CREATE TRIGGER IF NOT EXISTS forecasts_no_update BEFORE UPDATE ON forecasts
  BEGIN SELECT RAISE(ABORT, 'forecasts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecasts_no_delete BEFORE DELETE ON forecasts
  BEGIN SELECT RAISE(ABORT, 'forecasts are immutable'); END;

CREATE TABLE IF NOT EXISTS outcomes (
  forecast_id TEXT PRIMARY KEY REFERENCES forecasts(id),
  actual REAL NOT NULL,
  scored_at REAL NOT NULL,
  error REAL NOT NULL,            -- predicted - actual
  abs_error REAL NOT NULL,
  baseline_abs_error REAL NOT NULL,  -- |base price - actual|: what "unchanged" would have missed by
  in_range INTEGER                -- 1 / 0 / NULL when no range
);
CREATE TRIGGER IF NOT EXISTS outcomes_no_update BEFORE UPDATE ON outcomes
  BEGIN SELECT RAISE(ABORT, 'outcomes are write-once'); END;
CREATE TRIGGER IF NOT EXISTS outcomes_no_delete BEFORE DELETE ON outcomes
  BEGIN SELECT RAISE(ABORT, 'outcomes are write-once'); END;

CREATE TABLE IF NOT EXISTS models (
  version TEXT PRIMARY KEY,       -- e.g. fwd_5:random_forest:gold_v1
  task TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  feature_schema TEXT NOT NULL,
  status TEXT NOT NULL,           -- champion | challenger | retired | rejected
  created_at REAL NOT NULL,
  status_changed_at REAL NOT NULL,
  last_trained_at REAL,
  trained_through TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at REAL NOT NULL,
  task TEXT NOT NULL,
  kind TEXT NOT NULL,             -- evaluation | promotion | rollback | seed
  champion_before TEXT,
  champion_after TEXT,
  decision TEXT NOT NULL,         -- retain | promote | rollback | seed
  reason TEXT NOT NULL,
  evidence TEXT                   -- JSON
);

CREATE TABLE IF NOT EXISTS dev_evals (
  data_through TEXT NOT NULL,
  task TEXT NOT NULL,
  version TEXT NOT NULL,
  evaluated_at REAL NOT NULL,
  metrics TEXT NOT NULL,          -- JSON of walk-forward development metrics
  PRIMARY KEY (data_through, task, version)
);

CREATE TABLE IF NOT EXISTS news_items (
  article_id TEXT PRIMARY KEY,    -- hash of the normalised link
  title_key TEXT NOT NULL,        -- normalised title for syndication de-duplication
  title TEXT NOT NULL,
  source TEXT,
  link TEXT NOT NULL,
  published_at TEXT,              -- the publisher's original timestamp (ISO, UTC) - never overwritten
  first_seen_at REAL NOT NULL,    -- when this app first saw it
  duplicate_of TEXT
);
CREATE INDEX IF NOT EXISTS ix_news_title ON news_items(title_key);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at REAL NOT NULL,
  finished_at REAL,
  status TEXT NOT NULL,           -- running | ok | error | skipped
  detail TEXT
);
"""

_local = threading.local()
_init_lock = threading.Lock()
_inited: set[str] = set()


def path():
    return config.DATA_DIR / "gold.db"


def connect() -> sqlite3.Connection:
    """A per-thread connection (autocommit; use ``tx()`` for multi-statement atomicity)."""
    p = str(path())
    conn = getattr(_local, "conn", None)
    if conn is not None and getattr(_local, "path", None) == p:
        return conn
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    with _init_lock:
        if p not in _inited:
            conn.executescript(SCHEMA)
            _inited.add(p)
    _local.conn, _local.path = conn, p
    return conn


@contextmanager
def tx():
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def rows(sql: str, params: tuple = ()) -> list[dict]:
    return [dict(r) for r in connect().execute(sql, params).fetchall()]
