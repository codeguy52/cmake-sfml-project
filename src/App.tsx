import { useEffect, useState } from 'react';
import { flushPendingSave, useStore } from './store';
import Dashboard from './pages/Dashboard';
import BudgetPage from './pages/BudgetPage';
import ReceiptsPage from './pages/ReceiptsPage';
import TransactionsPage from './pages/TransactionsPage';
import InvestmentsPage from './pages/InvestmentsPage';
import FIPage from './pages/FIPage';
import SettingsPage, { applyTheme, readThemePreference } from './pages/SettingsPage';

export type View =
  | 'dashboard'
  | 'budget'
  | 'receipts'
  | 'transactions'
  | 'investments'
  | 'fi'
  | 'settings';

const NAV: { view: View; label: string; short: string; icon: string }[] = [
  { view: 'dashboard', label: 'Overview', short: 'Home', icon: '◧' },
  { view: 'budget', label: 'Budget', short: 'Budget', icon: '▤' },
  { view: 'receipts', label: 'Scan receipt', short: 'Scan', icon: '⬛' },
  { view: 'transactions', label: 'Transactions', short: 'Activity', icon: '≡' },
  { view: 'investments', label: 'Investments', short: 'Invest', icon: '◫' },
  { view: 'fi', label: 'Independence', short: 'FI', icon: '◎' },
  { view: 'settings', label: 'Settings', short: 'Settings', icon: '⚙' },
];

/** Views are kept in the URL hash so the back button and a reload both work. */
function viewFromHash(): View {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return NAV.some((n) => n.view === raw) ? (raw as View) : 'dashboard';
}

export default function App() {
  const { load, loading, error, setError } = useStore();
  const [view, setView] = useState<View>(viewFromHash);

  useEffect(() => {
    applyTheme(readThemePreference());
    void load();
  }, [load]);

  useEffect(() => {
    const onHashChange = (): void => setView(viewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // A phone can discard the tab without a beforeunload, so commit on hide
  // rather than trusting an unload event to fire.
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') void flushPendingSave();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  const navigate = (next: View): void => {
    window.location.hash = `#/${next}`;
    setView(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Sections">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            ◎
          </div>
          <div>
            <div className="brand-name">Ember</div>
            <div className="brand-sub">Budget &amp; independence</div>
          </div>
        </div>

        {NAV.map((item) => (
          <button
            key={item.view}
            type="button"
            className="nav-item"
            aria-current={view === item.view ? 'page' : undefined}
            onClick={() => navigate(item.view)}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            {/* Two labels, one shown per breakpoint: seven full labels don't
                fit across a phone-width tab bar without the last one falling
                off the edge. */}
            <span className="nav-label-full">{item.label}</span>
            <span className="nav-label-short">{item.short}</span>
          </button>
        ))}

        <div className="sidebar-footer">
          Stored on this device only.
          <br />
          Export a backup from Settings.
        </div>
      </nav>

      <main className="main">
        {error && (
          <div className="banner" role="alert" style={{ marginBottom: 18, borderRadius: 8 }}>
            <span>{error}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <p className="muted">Loading your data…</p>
        ) : (
          <>
            {view === 'dashboard' && <Dashboard onNavigate={navigate} />}
            {view === 'budget' && <BudgetPage />}
            {view === 'receipts' && <ReceiptsPage />}
            {view === 'transactions' && <TransactionsPage />}
            {view === 'investments' && <InvestmentsPage />}
            {view === 'fi' && <FIPage />}
            {view === 'settings' && <SettingsPage />}
          </>
        )}
      </main>
    </div>
  );
}
