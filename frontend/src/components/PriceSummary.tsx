import type { MarketSummary } from "../types";
import { arrow, dirClass, num, pct, signed } from "../format";
import { Info } from "./Common";

export function PriceSummary({ s, err }: { s: MarketSummary | null; err: string | null }) {
  if (!s) return <section className="gx-summary" aria-busy="true"><div className="gx-price mono gx-skel">——.——</div><p className="gx-muted">{err ?? "Loading price…"}</p></section>;
  const cls = s.change != null ? dirClass(s.change) : "flat";
  const stat = (label: string, v: number | null, note?: string | null) => (
    <div className="gx-stat"><span>{label}</span><b className="mono" title={note ?? undefined}>{v != null ? num(v) : "—"}{note ? <sup>*</sup> : null}</b></div>
  );
  const prevMissing = s.previous_close == null;
  return (
    <section className="gx-summary" aria-label="Price summary">
      <div className="gx-price-row">
        <div className="gx-price mono" data-testid="price">{num(s.price)}</div>
        <div className="gx-cur">USD<br /><span>per troy oz</span></div>
        {s.change != null ? (
          <div className={`gx-change mono ${cls}`} data-testid="change">
            <span aria-hidden="true">{arrow(s.change)}</span> {signed(s.change)} <span>({pct(s.change_pct ?? 0)})</span>
          </div>
        ) : <div className="gx-change gx-muted" data-testid="change">Change unavailable — no previous close recorded yet</div>}
      </div>
      <div className="gx-stats">
        {stat("Session open", s.session.open, s.session.open_note)}
        {prevMissing
          ? <div className="gx-stat" data-testid="prev-close-missing"><span>Previous close</span><b className="gx-unavail">Unavailable from provider<Info label="Previous close" text={s.previous_close_note} /></b></div>
          : stat("Previous close", s.previous_close, null)}
        {stat("Session high", s.session.high)}
        {stat("Session low", s.session.low)}
        <Info label="Session definition" text={`${s.session.convention}${s.session.open_note ? " * " + s.session.open_note : ""}`} />
      </div>
      <p className="gx-micro">{s.name} · {s.provider}{s.previous_close_date ? ` · previous close = ${s.previous_close_date} settlement` : ""}</p>
    </section>
  );
}
