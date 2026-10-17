import { useEffect, useState, type ReactNode } from 'react';
import { CopyX, Hourglass, Layers, RotateCcw, Siren, Skull, Terminal, type LucideIcon } from 'lucide-react';
import type { JobDetail, SubmitJobResponse } from '@queueforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { StateBadge } from '@/components/StateBadge';
import { useDashboard } from '@/context/useDashboard';
import { formatTime, shortId } from '@/lib/format';
import { api, ApiError } from '@/services/api';

/** A deterministic mix of the three job types, sized so progress is visible on a laptop. */
function sampleJob(i: number) {
  switch (i % 3) {
    case 0:
      return { type: 'report-generation', data: { reportName: `Sample report ${i + 1}`, recordCount: 20_000 + (i % 5) * 10_000, batchDelayMs: 25 } };
    case 1:
      return {
        type: 'data-transformation',
        data: {
          records: Array.from({ length: 200 }, (_, r) => ({ region: ['EMEA', 'APAC', 'NA'][r % 3], value: (r * 37) % 101, sku: `S-${r % 40}` })),
          operations: [
            { op: 'dedupe', fields: ['sku', 'region'] },
            { op: 'filter', field: 'value', operator: 'gte', value: 20 },
            { op: 'group', by: ['region'], aggregates: [{ fn: 'count' }, { fn: 'sum', field: 'value', as: 'total' }] },
          ],
        },
      };
    default:
      return { type: 'failure-simulation', data: { durationMs: 1_500 + (i % 4) * 1_000, steps: 6, label: `sample-${i + 1}` } };
  }
}

function useWatchedJob(jobId: string | null) {
  const { subscribe } = useDashboard();
  const [job, setJob] = useState<JobDetail | null>(null);
  useEffect(() => {
    if (!jobId) return;
    const load = () => void api.getJob(jobId).then(setJob).catch(() => undefined);
    load();
    const unsubscribe = subscribe((e) => e.jobId === jobId && load());
    const t = setInterval(load, 1_000);
    return () => {
      unsubscribe();
      clearInterval(t);
    };
  }, [jobId, subscribe]);
  return job;
}

function Demo({ icon: Icon, title, description, children }: { icon: LucideIcon; title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <Icon className="size-4.5" />
          </div>
          <div>
            <CardTitle>{title}</CardTitle>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function JobLine({ job, label }: { job: JobDetail | null; label?: string }) {
  const { openJob } = useDashboard();
  if (!job) return null;
  return (
    <button onClick={() => openJob(job.id)} className="flex w-full items-center gap-3 rounded-lg border p-2.5 text-left hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          {label && <span className="text-muted-foreground">{label}</span>}
          <span className="font-mono">{shortId(job.id)}</span>
          <span className="text-muted-foreground">
            attempts {job.attemptsMade}/{job.maxAttempts}
          </span>
        </div>
        <Progress value={job.progress} className="mt-1.5" />
      </div>
      <StateBadge state={job.state} awaitingRetry={job.awaitingRetry} />
    </button>
  );
}

function errorText(err: unknown) {
  return err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message;
}

function BulkDemo() {
  const [status, setStatus] = useState<string | null>(null);
  const submit = async (n: number) => {
    setStatus('Submitting…');
    try {
      const res = await api.submitBatch(Array.from({ length: n }, (_, i) => sampleJob(i)));
      setStatus(`${res.accepted} jobs accepted in one request. Watch the stat cards and the event feed as the workers drain the queue.`);
    } catch (err) {
      setStatus(errorText(err));
    }
  };
  return (
    <Demo
      icon={Layers}
      title="Throughput demonstration"
      description="Submit a batch of mixed jobs (reports, transformations, simulated I/O) and watch independent workers share the queue. Add workers with docker compose up --scale worker=4 to see the queue drain faster."
    >
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void submit(10)}>
          Submit 10 sample jobs
        </Button>
        <Button variant="outline" onClick={() => void submit(100)}>
          Submit 100 sample jobs
        </Button>
      </div>
      {status && <p className="text-xs text-muted-foreground">{status}</p>}
    </Demo>
  );
}

function RetryDemo() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useWatchedJob(jobId);
  const start = async () => {
    setError(null);
    try {
      const res = await api.submit({ type: 'failure-simulation', data: { durationMs: 1_500, steps: 5, failFirstAttempts: 2, label: 'retry-demo' } });
      setJobId(res.jobId);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Demo
      icon={RotateCcw}
      title="Retry demonstration"
      description="Watch a job fail twice and automatically succeed on its third attempt using exponential backoff (1 s, then 2 s). Failures are deterministic: the job fails while BullMQ's attemptsMade counter is below 2."
    >
      <Button onClick={() => void start()} className="w-fit">
        Create a job that fails twice
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <JobLine job={job} />
      {job && job.history.length > 0 && (
        <ol className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
          {job.history.map((h, i) => (
            <li key={i}>
              {formatTime(h.at)} · {h.event} · execution #{h.execution}
              {h.willRetry ? ' · retry scheduled' : ''}
            </li>
          ))}
        </ol>
      )}
    </Demo>
  );
}

function DedupDemo() {
  const [responses, setResponses] = useState<Array<SubmitJobResponse & { httpStatus: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const job = useWatchedJob(responses[0]?.jobId ?? null);
  const payload = { type: 'failure-simulation', data: { durationMs: 10_000, steps: 10, label: 'dedup-demo' }, options: { deduplicationKey: 'playground-dedup' } };
  const run = async () => {
    setError(null);
    try {
      const first = await api.submit(payload);
      const second = await api.submit(payload);
      setResponses([first, second]);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Demo
      icon={CopyX}
      title="Deduplication demonstration"
      description="Submit the same job twice with the deduplication key “playground-dedup” and observe how the queue suppresses duplicate pending work. Once the original completes or fails, the key is released and the same key creates a new job."
    >
      <Button onClick={() => void run()} variant="outline" className="w-fit">
        Submit a duplicate job
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {responses.map((r, i) => (
        <div key={i} className="rounded-lg border bg-muted/40 p-2.5 text-xs">
          <div className="flex justify-between font-medium">
            <span>
              Request {i + 1}: HTTP {r.httpStatus}
            </span>
            <span className="font-mono">{shortId(r.jobId)}</span>
          </div>
          <div className="mt-1 text-muted-foreground">
            {r.deduplicated ? 'deduplicated: true · ' : 'deduplicated: false · '}
            {r.message}
          </div>
        </div>
      ))}
      <JobLine job={job} label="Original" />
    </Demo>
  );
}

function LongRunningDemo() {
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useWatchedJob(jobId);
  return (
    <Demo
      icon={Hourglass}
      title="Long-running job"
      description="A 30-second simulated I/O-bound job. The API answered in milliseconds; the work happens in a worker, which keeps renewing its lock while progress updates stream to this page."
    >
      <Button
        variant="outline"
        className="w-fit"
        onClick={() =>
          void api.submit({ type: 'failure-simulation', data: { durationMs: 30_000, steps: 30, label: 'long-running' } }).then((r) => setJobId(r.jobId))
        }
      >
        Submit a long-running job
      </Button>
      <JobLine job={job} />
    </Demo>
  );
}

function RecoveryDemo() {
  const { config, workers } = useDashboard();
  const [jobId, setJobId] = useState<string | null>(null);
  const [crashed, setCrashed] = useState<{ workerId: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useWatchedJob(jobId);
  const owner = job?.state === 'active' ? job.processedBy : null;
  const enabled = config?.demoControlsEnabled ?? false;
  const freshWorkers = workers?.workers.filter((w) => w.fresh).length ?? 0;

  const start = async () => {
    setError(null);
    setCrashed(null);
    try {
      const res = await api.submit({ type: 'failure-simulation', data: { durationMs: 20_000, steps: 20, label: 'recovery-demo' } });
      setJobId(res.jobId);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const crash = async () => {
    if (!owner) return;
    setError(null);
    try {
      await api.crashWorker(owner);
      setCrashed({ workerId: owner, at: Date.now() });
    } catch (err) {
      setError(errorText(err));
    }
  };
  const recovered = job?.history.find((h) => h.event === 'stalled-recovered');

  return (
    <Demo
      icon={Siren}
      title="Worker recovery demonstration"
      description="Observe how a stalled job can be recovered by another worker after its original worker crashes. The worker is killed with SIGKILL, so it cannot release its lock. BullMQ's stalled checker notices once the lock expires and returns the job to the queue under the same id."
    >
      {!enabled ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Terminal className="size-3.5" /> Crash controls are disabled (default)
          </div>
          <p>
            The crash endpoint only exists when the API runs with <code className="font-mono">DEMO_CONTROLS_ENABLED=true</code> and workers with{' '}
            <code className="font-mono">WORKER_ALLOW_CRASH_COMMANDS=true</code> (the local Docker Compose setup enables both). Without them, reproduce
            the scenario from a terminal:
          </p>
          <pre className="rounded bg-muted p-2 font-mono text-[11px]">npm run demo:crash-recovery</pre>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void start()} className="w-fit">
              1 · Start a 20 s job
            </Button>
            <Button variant="destructive" disabled={!owner || !!crashed} onClick={() => void crash()}>
              <Skull /> 2 · Crash {owner ?? 'its worker'}
            </Button>
          </div>
          {freshWorkers < 2 && (
            <p className="text-xs text-muted-foreground">
              Tip: with a single worker, recovery waits for Docker to restart the killed container. Run{' '}
              <code className="font-mono">docker compose up --scale worker=2</code> to see a different worker take over.
            </p>
          )}
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <JobLine job={job} />
      {crashed && (
        <ol className="flex flex-col gap-1 text-xs">
          <li>
            💥 {formatTime(new Date(crashed.at).toISOString())}: <span className="font-mono">{crashed.workerId}</span> killed mid-execution
          </li>
          {recovered ? (
            <li>
              🔎 {formatTime(recovered.at)}: lock expired, picked up by <span className="font-mono">{recovered.workerId}</span> (
              {((Date.parse(recovered.at) - crashed.at) / 1000).toFixed(1)} s after the crash)
            </li>
          ) : (
            <li className="text-muted-foreground">⏳ Waiting for the lock to expire and a stalled check to run…</li>
          )}
          {job?.state === 'completed' && (
            <li>
              ✅ {formatTime(job.finishedAt)}: completed by <span className="font-mono">{job.processedBy}</span>, same job id, stall count {job.stalledCount}
            </li>
          )}
        </ol>
      )}
    </Demo>
  );
}

export function PlaygroundPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border bg-card p-4 text-xs leading-relaxed text-muted-foreground shadow-xs">
        Every demonstration submits real jobs through the REST API. They are stored in Redis and processed by independent worker processes. Nothing
        on this page is simulated in the browser, and the job detail panel shows exactly what BullMQ and the workers recorded.
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <BulkDemo />
        <RetryDemo />
        <DedupDemo />
        <LongRunningDemo />
        <div className="lg:col-span-2">
          <RecoveryDemo />
        </div>
      </div>
    </div>
  );
}
