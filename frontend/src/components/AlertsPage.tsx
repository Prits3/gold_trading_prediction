import { AlertsPanel } from "./AlertsPanel";
import { DataSettings } from "./Drawer";

/** Alerts, notification configuration and data-source settings. Secondary to the Forecast page: nothing here changes a forecast. */
export function AlertsPage({ onDataChanged }: { onDataChanged: () => void }) {
  return (
    <div className="gx-page" data-testid="page-alerts">
      <AlertsPanel />
      <section className="gx-card" data-testid="settings-data">
        <h2>DATA SOURCES</h2>
        <DataSettings onChanged={onDataChanged} />
      </section>
    </div>
  );
}
