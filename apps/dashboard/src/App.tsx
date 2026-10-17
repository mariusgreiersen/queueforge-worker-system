import { useEffect, useState } from 'react';
import { Activity, BookOpen, Cpu, FlaskConical, LayoutDashboard, ListTodo, Moon, RefreshCw, Sun, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EventFeed } from '@/components/EventFeed';
import { JobDetailSheet } from '@/components/JobDetailSheet';
import { JobsTable } from '@/components/JobsTable';
import { WorkerList } from '@/components/WorkerList';
import { DashboardProvider } from '@/context/dashboard';
import { useDashboard } from '@/context/useDashboard';
import { cn } from '@/lib/utils';
import { OverviewPage } from '@/pages/OverviewPage';
import { PlaygroundPage } from '@/pages/PlaygroundPage';
import { API_BASE } from '@/services/api';

const PAGES: Array<{ id: string; label: string; icon: LucideIcon; title: string; subtitle: string }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, title: 'Overview', subtitle: 'Live queue state from Redis via BullMQ' },
  { id: 'jobs', label: 'Jobs', icon: ListTodo, title: 'Jobs', subtitle: 'Filter, search and inspect every retained job' },
  { id: 'workers', label: 'Workers', icon: Cpu, title: 'Workers', subtitle: 'Independent worker processes reporting heartbeats' },
  { id: 'playground', label: 'Reliability Playground', icon: FlaskConical, title: 'Reliability Playground', subtitle: 'Retries, deduplication and crash recovery, live' },
];

function useHashPage() {
  const read = () => {
    const id = window.location.hash.replace('#/', '');
    return PAGES.some((p) => p.id === id) ? id : 'overview';
  };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onHash = () => setPage(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return [page, (id: string) => (window.location.hash = `#/${id}`)] as const;
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('qf-theme', next ? 'dark' : 'light');
    } catch {
      // Storage unavailable (private mode): the toggle still works for this session.
    }
  };
  return { dark, toggle };
}

function Sidebar({ page, onNavigate }: { page: string; onNavigate: (id: string) => void }) {
  const { stats, stream } = useDashboard();
  return (
    <aside className="flex w-full shrink-0 flex-col border-sidebar-border bg-sidebar text-sidebar-foreground md:h-screen md:w-60 md:border-r">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-500 shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset]">
          <Activity className="size-4.5 text-white" />
        </div>
        <div>
          <div className="text-sm font-semibold text-white">QueueForge</div>
          <div className="text-[11px] text-sidebar-muted">Background job processing</div>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 md:flex-col">
        {PAGES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors',
              page === id ? 'bg-sidebar-accent font-medium text-white' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-white',
            )}
          >
            <Icon className={cn('size-4', page === id ? 'text-indigo-300' : 'text-sidebar-muted')} />
            {label}
          </button>
        ))}
        <a
          href={`${API_BASE}/docs`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-white"
        >
          <BookOpen className="size-4 text-sidebar-muted" /> API docs
        </a>
      </nav>
      <div className="mt-auto hidden border-t border-sidebar-border px-5 py-4 text-[11px] text-sidebar-muted md:block">
        <div className="flex items-center justify-between">
          <span>Queue</span>
          <span className="font-mono text-sidebar-foreground">{stats?.queue ?? '…'}</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span>Event stream</span>
          <span className="flex items-center gap-1.5 text-sidebar-foreground">
            <span className={cn('size-1.5 rounded-full', stream === 'live' ? 'bg-emerald-400' : 'animate-pulse bg-amber-400')} />
            {stream}
          </span>
        </div>
      </div>
    </aside>
  );
}

function Shell() {
  const [page, navigate] = useHashPage();
  const { dark, toggle } = useTheme();
  const { refresh, statsError } = useDashboard();
  const meta = PAGES.find((p) => p.id === page)!;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar page={page} onNavigate={navigate} />
      <main className="min-w-0 flex-1 md:h-screen md:overflow-y-auto">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/85 px-4 py-3.5 backdrop-blur md:px-8">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">{meta.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{meta.subtitle}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon" onClick={refresh} aria-label="Refresh">
              <RefreshCw />
            </Button>
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle dark mode">
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-5 md:px-8">
          {statsError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
              Cannot reach the QueueForge API ({statsError}). Showing last known data.
            </div>
          )}
          {page === 'overview' && <OverviewPage onNavigate={navigate} />}
          {page === 'jobs' && (
            <Card className="gap-3">
              <JobsTable pageSize={20} />
            </Card>
          )}
          {page === 'workers' && (
            <div className="grid gap-4 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <WorkerList />
              </div>
              <div className="h-[600px]">
                <EventFeed />
              </div>
            </div>
          )}
          {page === 'playground' && <PlaygroundPage />}
        </div>
      </main>
      <JobDetailSheet />
    </div>
  );
}

export function App() {
  return (
    <DashboardProvider>
      <Shell />
    </DashboardProvider>
  );
}
