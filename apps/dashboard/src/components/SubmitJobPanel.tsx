import { useState } from 'react';
import { Send } from 'lucide-react';
import type { SubmitJobResponse } from '@queueforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/form';
import { useDashboard } from '@/context/useDashboard';
import { JOB_TYPE_LABELS } from '@/lib/format';
import { api, ApiError } from '@/services/api';

const JOB_TEMPLATES: Record<string, unknown> = {
  'report-generation': { reportName: 'Monthly Sales Report', recordCount: 50000, format: 'json', batchDelayMs: 40 },
  'data-transformation': {
    records: [
      { name: ' Alice ', team: 'core', score: 91 },
      { name: 'Bob', team: 'infra', score: 78 },
      { name: 'Bob', team: 'infra', score: 78 },
      { name: 'Carol', team: 'core', score: 85 },
    ],
    operations: [
      { op: 'dedupe' },
      { op: 'normalize', fields: ['name'], mode: 'trim' },
      { op: 'group', by: ['team'], aggregates: [{ fn: 'count' }, { fn: 'avg', field: 'score', as: 'avgScore' }] },
    ],
  },
  'failure-simulation': { durationMs: 8000, steps: 10, failFirstAttempts: 0, failureMode: 'transient' },
};

export function SubmitJobPanel() {
  const { openJob, refresh } = useDashboard();
  const [type, setType] = useState('report-generation');
  const [data, setData] = useState(() => JSON.stringify(JOB_TEMPLATES['report-generation'], null, 2));
  const [priority, setPriority] = useState('');
  const [dedupKey, setDedupKey] = useState('');
  const [attempts, setAttempts] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(SubmitJobResponse & { httpStatus: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      setError('Payload is not valid JSON');
      return;
    }
    const options: Record<string, unknown> = {};
    if (priority) options.priority = Number(priority);
    if (dedupKey) options.deduplicationKey = dedupKey;
    if (attempts) options.attempts = Number(attempts);
    setBusy(true);
    try {
      const res = await api.submit({ type, data: parsed, ...(Object.keys(options).length ? { options } : {}) });
      setResult(res);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setError(`${err.message}: ${(err.details as Array<{ path: string; message: string }>).map((d) => `${d.path} ${d.message}`).join('; ')}`);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Submit a job</CardTitle>
          <CardDescription>POST /api/v1/jobs: validated, enqueued, answered with 202 immediately</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="job-type">Job type</Label>
          <NativeSelect
            id="job-type"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setData(JSON.stringify(JOB_TEMPLATES[e.target.value], null, 2));
            }}
          >
            {Object.entries(JOB_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="job-data">Payload (data)</Label>
          <Textarea id="job-data" rows={8} value={data} onChange={(e) => setData(e.target.value)} spellCheck={false} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="opt-priority">Priority (1–10)</Label>
            <Input id="opt-priority" inputMode="numeric" placeholder="none" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="opt-attempts">Attempts (1–5)</Label>
            <Input id="opt-attempts" inputMode="numeric" placeholder="3" value={attempts} onChange={(e) => setAttempts(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="opt-dedup">Dedup key</Label>
            <Input id="opt-dedup" placeholder="optional" value={dedupKey} onChange={(e) => setDedupKey(e.target.value)} />
          </div>
        </div>
        <Button onClick={() => void submit()} disabled={busy}>
          <Send /> {busy ? 'Submitting…' : 'Submit job'}
        </Button>
        {error && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
        {result && (
          <div className="rounded-md border bg-muted/40 p-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium">
                HTTP {result.httpStatus} · {result.deduplicated ? 'deduplicated' : 'accepted'}
              </span>
              <button className="font-mono text-primary hover:underline" onClick={() => openJob(result.jobId)}>
                {result.jobId.slice(0, 16)}…
              </button>
            </div>
            <div className="mt-1 text-muted-foreground">{result.message}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
