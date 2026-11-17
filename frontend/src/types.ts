export type Horizon = 1 | 5 | 20;
export type MethodKey = "ridge" | "random_forest" | "unchanged";

export interface Instrument { name: string; kind: string; unit: string; note: string }

export interface PricePayload {
  data_key: string;
  source: string;
  source_kind: "provider" | "upload";
  symbol: string | null;
  instrument: Instrument;
  fetched_at: string;
  age_minutes: number;
  warnings: string[];
  provider_error: string | null;
  status: { mode: "live" | "cached" | "upload"; label: string };
  session: { latest_is_completed_session: boolean; in_progress: { price: number; time: string; session_date: string } | null; note: string };
  freshness: { latest_date: string; age_days: number; status: "fresh" | "stale"; message: string };
  latest: { date: string; close: number; previous_date: string; previous_close: number; change: number; change_pct: number };
  stats: { realised_vol_20d_annualised_pct: number };
  count: number;
  first_date: string;
  prices: { date: string; close: number }[];
}

export interface Span { start: string; end: string; n: number }
export interface MethodResult { label: string; mae: number; directional_accuracy: number | null; vs_baseline_pct?: number }

export interface Prediction {
  data_key: string;
  served_from_cache: boolean;
  generated_at: string;
  horizon: Horizon;
  base_date: string;
  target_date: string;
  base_price: number;
  forecast: {
    model: MethodKey;
    model_label: string;
    price: number;
    change_pct: number;
    interval: {
      level: number; low: number; high: number; low_pct: number; high_pct: number;
      observed_coverage_pct: number; mean_width_usd_on_test: number; z_low: number; z_high: number;
      scale: string; calibrated_on: Span; evaluated_on: Span; built_from: string;
    };
  };
  selection: { default: MethodKey; rule: string; validation_mae: Record<MethodKey, number> };
  test: {
    period: { start: string; end: string };
    n: number;
    effective_n: number;
    methods: Record<MethodKey, MethodResult>;
    always_up_pct: number;
    within_tolerance: Record<string, Record<MethodKey | "default", number>>;
    advantage: boolean;
    verdict: string;
  };
  training: { closes: number; first_close: string; last_close: string; usable_samples: number; n_features: number };
  calendar: { name: string; library: string; rule: string };
  splits: Record<"train" | "validation" | "test", Span>;
  test_series: { date: string; actual: number; predicted: number; baseline: number }[];
  features: { name: string; label: string }[];
}

export interface Quote {
  symbol: string;
  price: number;
  sell: number;
  buy: number;
  spread: number;
  spread_indicative: boolean;
  day_open: number | null;
  previous_close: number | null;
  change: number | null;
  change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  currency: string;
  instrument: string;
  source: string;
  market_open: boolean;
  quote_time_epoch: number | null;
  delay_seconds: number | null;
  as_of_epoch: number;
  cached: boolean;
}

export type InstrumentKey = "futures" | "spot";
export type RangeKey = "1D" | "1W" | "1M" | "3M" | "1Y" | "5Y";
export type Conn = "ok" | "reconnecting" | "offline";

export interface Bar { time: number | string; open: number; high: number; low: number; close: number; volume?: number | null }
export interface OhlcPayload {
  instrument: InstrumentKey; range: RangeKey; interval: string; time_kind: "epoch" | "day"; bars: Bar[]; source: string; real_ohlc: boolean;
  history_start: number | string | null; delay_seconds: number | null; timezone: string; gap_policy: string;
}
export interface MarketStatus { state: "live" | "delayed" | "stale" | "closed" | "unavailable"; label: string }
export interface MarketSummary {
  instrument: InstrumentKey; name: string; currency: string; unit: string; price: number; as_of_epoch: number | null; delay_seconds: number | null; status: MarketStatus;
  session: { date: string; open: number | null; high: number; low: number; starts: string; convention: string; open_note?: string | null };
  previous_close: number | null; previous_close_status: "recorded" | "unavailable_from_provider"; previous_close_note: string; previous_close_date: string | null; change: number | null; change_pct: number | null; update_every_seconds: number; provider: string;
}

export interface ForwardStats {
  n_matured: number; n_sessions: number; mae?: number; baseline_mae?: number; mae_vs_baseline_pct?: number | null; coverage_pct?: number | null;
  effective_blocks?: number; needed_for_verdict?: number; mae_diff_ci90_pct?: [number, number];
}
export interface DevMetrics { by_period_coverage_pct?: number[]; coverage_ci90_pct?: [number, number]; n_origins: number; mae: number; baseline_mae: number; mae_vs_baseline_pct: number; direction_pct: number; coverage_pct: number | null; mean_width_pct: number | null; p_value_vs_baseline: number; by_period_vs_baseline_pct: number[]; data_through: string }
export interface TaskStatus {
  champion: { version: string; algorithm: string; feature_schema: string; status_changed_at: number; last_trained_at: number | null; trained_through: string | null };
  baseline_version: string; forecasts_issued: number; forward: ForwardStats; development: DevMetrics | null; calibration?: CalibrationInfo;
  last_decision: { at: number; decision: string; reason: string; champion_after: string } | null;
  challengers: { version: string; status: string; last_trained_at: number | null; forward: ForwardStats }[];
}
export interface Decision { id: number; at: number; task: string; kind: string; champion_before: string | null; champion_after: string | null; decision: string; reason: string }
export interface WorkerStatus { daemon_running: boolean; heartbeat_age_s: number | null; jobs: Record<string, { last: { status: string; detail: string | null } | null; last_ok: number | null; age_s: number | null }>; forecasts: number; matured: number; spot_ticks: number; cycle_overdue: boolean }
export interface DriversResearch {
  ran_at: string; data_through: string; driver_errors: Record<string, string>; duration_s: number;
  horizons: Record<string, { n_origins: number; oos_start: string; oos_end: string; paired_drivers_vs_gold_only: Record<string, { delta_pct_of_baseline_mae: number; ci90: [number, number] }>;
    results: { algorithm: string; features: string; mae_vs_baseline_pct: number; mae_diff_ci90_pct: [number, number]; direction_pct: number; coverage_pct: number; by_period_vs_baseline_pct: number[] }[] }>;
  conclusion: Record<string, { verdict: string; drivers_help_significantly: string[]; beats_unchanged_price: string[] }>;
}
export interface LearningPayload {
  tasks: Record<string, TaskStatus>; rule: string[]; history: Decision[]; matured_total: number; issued_total: number; worker: WorkerStatus;
  news: { stored: number; unique_stories: number; collecting_since: number | null; last_seen: number | null; note: string };
  drivers_research: DriversResearch | null;
}
export interface DriverItem { key: string; label: string; status: "fresh" | "stale" | "missing"; value?: number; unit: string; change?: number | null; change_unit?: string; obs_date?: string; available_at?: string; retrieved_at?: string; source: string; age_days?: number; note?: string | null; error?: string | null }
export interface DriversPanel { status: string; items: DriverItem[]; note?: string; message?: string }

export interface NewsTheme { id: string; label: string; background: string; count: number; share_pct: number; examples: { title: string; link: string; source: string; published: string }[] }
export interface NewsItem { title: string; source: string; link: string; published: string; themes: string[] }
export interface NewsPayload {
  status: "ok" | "partial" | "stale" | "error";
  message: string | null;
  items: NewsItem[];
  themes: NewsTheme[];
  n_items: number;
  fetched_at: string | null;
  source: string;
  method?: string;
}

export interface GldComparison {
  configured: boolean;
  note: string;
  setup?: string[];
  instrument?: Instrument;
  source?: string;
  fetched_at?: string;
  age_minutes?: number;
  provider_error?: string | null;
  status?: { mode: "live" | "cached"; label: string };
  latest?: { date: string; close: number; change_pct: number };
  count?: number;
  gold_source?: string;
  comparison?: {
    common_dates: number;
    start: string;
    end: string;
    indexed: { date: string; gc: number; gld: number }[];
    window: { sessions: number; start: string; end: string; return_correlation: number; gc_return_pct: number; gld_return_pct: number };
  };
}

export interface ForecastSource {
  kind: "baseline" | "model"; label: string; version: string; algorithm: string; feature_schema: string; role: string; target_def: string;
}
/** A forecast exactly as it was issued. Nothing in it changes when quotes move. */
export interface FrozenForecast {
  forecast_id: string; predicted: number; low: number; high: number; level: number; reference_price: number; change: number; change_pct: number;
  little_change: boolean; little_change_threshold_pct: number; issued_at: number; input_cutoff: number; target_date: string; target_time: string;
  horizon: number | null; source: ForecastSource;
}
export interface CalibrationInfo {
  target_pct: number; historical_pct: number | null; ci90_pct?: [number, number] | null; n_dates?: number | null; by_period_pct?: number[] | null;
  historical_basis?: string; mean_width_pct?: number | null; mean_width_usd?: number; label: string | null; forward_pct?: number | null; forward_n?: number;
  typical_error_usd?: number | null;
}
export interface ForecastResult { matured: boolean; actual: number | null; abs_error: number | null; in_range: boolean | null }
export interface NextForecastInfo { state: "waiting_for_provider" | "issuing" | "scheduled"; message: string }
export interface PendingSettlement { date: string; reason: string; close_seen?: number; settlement_price?: number }
export interface TodayPayload {
  status: "current" | "completed" | "none"; message?: string; forecast?: FrozenForecast; result?: ForecastResult | null; market_open?: boolean;
  next_update_epoch?: number | null; pending_settlement?: PendingSettlement | null; calibration?: CalibrationInfo;
  live?: { price: number; as_of_epoch: number; delay_seconds: number; label: string; vs_forecast: number; vs_forecast_pct: number };
  next_target?: { target_date: string; target_time: string };
  last_result?: { target_date: string; predicted: number; actual: number | null; abs_error: number | null; in_range: boolean | null; status: "scored" | "awaiting_official_figure" };
}
export interface ForwardPayload {
  status: "current" | "completed" | "none"; horizon: Horizon; message?: string; forecast?: FrozenForecast; result?: ForecastResult | null; base_date?: string;
  calibration?: CalibrationInfo; next_forecast?: NextForecastInfo;
  evaluation?: { development: DevMetrics | null; forward: ForwardStats };
}
