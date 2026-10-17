import type {
  BatchSubmitResponse,
  ErrorResponse,
  JobDetail,
  ListJobsResponse,
  QueueStats,
  ServerConfig,
  SubmitJobResponse,
  WorkersResponse,
} from '@queueforge/shared';

/** Same-origin by default (Vite proxy in dev, nginx in Docker). Override with VITE_API_BASE_URL. */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (body as ErrorResponse | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return { status: res.status, body: body as T };
}

export interface ListParams {
  state?: string;
  type?: string;
  sort?: 'newest' | 'oldest';
  page?: number;
  pageSize?: number;
  search?: string;
}

export const api = {
  stats: () => request<QueueStats>('/api/v1/queues/stats').then((r) => r.body),
  workers: () => request<WorkersResponse>('/api/v1/workers').then((r) => r.body),
  config: () => request<ServerConfig>('/api/v1/config').then((r) => r.body),
  listJobs: (p: ListParams) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '' && v !== 'all') qs.set(k, String(v));
    return request<ListJobsResponse>(`/api/v1/jobs?${qs}`).then((r) => r.body);
  },
  getJob: (id: string) => request<JobDetail>(`/api/v1/jobs/${encodeURIComponent(id)}`).then((r) => r.body),
  submit: (payload: unknown) =>
    request<SubmitJobResponse>('/api/v1/jobs', { method: 'POST', body: JSON.stringify(payload) }).then((r) => ({
      httpStatus: r.status,
      ...r.body,
    })),
  submitBatch: (jobs: unknown[]) =>
    request<BatchSubmitResponse>('/api/v1/jobs/batch', { method: 'POST', body: JSON.stringify({ jobs }) }).then((r) => r.body),
  retry: (id: string) => request<{ status: string }>(`/api/v1/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }).then((r) => r.body),
  cancel: (id: string) => request<{ status: string }>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then((r) => r.body),
  crashWorker: (workerId: string) =>
    request<{ message: string }>(`/api/v1/demo/workers/${encodeURIComponent(workerId)}/crash`, { method: 'POST' }).then((r) => r.body),
};
