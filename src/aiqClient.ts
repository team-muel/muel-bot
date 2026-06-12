import { config } from './config.js';

/**
 * AI-Q REST client.
 *
 * Wraps the NVIDIA AI-Q Blueprint async jobs API:
 *   POST /v1/jobs/async/submit
 *   GET  /v1/jobs/async/job/{job_id}
 *   GET  /v1/jobs/async/job/{job_id}/report
 *   POST /v1/jobs/async/job/{job_id}/cancel
 *   GET  /health
 *
 * Auth: a shared bearer token (AIQ_AUTH_TOKEN) checked by the front-proxy in
 * front of AI-Q backend. AI-Q itself does not enforce it; the proxy does.
 *
 * Payload discipline: callers MUST pass `topic` as a self-contained string.
 * Do NOT enrich with user memory, conversation history, or any other private
 * context — that data would be persisted in aiq_jobs.job_events on AI-Q's side.
 */

export type AiqAgentType = 'deep_researcher' | 'shallow_researcher' | (string & {});

export type AiqSubmitInput = {
  topic: string;
  agentType?: AiqAgentType;
  jobId?: string;
  expirySeconds?: number;
};

export type AiqJobStatus = 'SUBMITTED' | 'RUNNING' | 'SUCCESS' | 'FAILURE' | 'INTERRUPTED';

export type AiqJobStatusResponse = {
  jobId: string;
  status: AiqJobStatus;
  agentType?: string;
  error?: string | null;
  createdAt?: string;
};

export type AiqJobReport = {
  jobId: string;
  hasReport: boolean;
  report: string;
};

export type AiqJobState = {
  jobId: string;
  hasState: boolean;
  state: unknown;
  artifacts?: {
    tools?: Array<Record<string, unknown>>;
    outputs?: Array<{ type?: string; content?: string; workflow?: string }>;
    sources?: {
      found?: number;
      cited?: number;
      foundUrls?: string[];
      citedUrls?: string[];
    };
  };
};

export class AiqClientError extends Error {
  readonly status: number;
  readonly responseBody: unknown;
  constructor(message: string, status: number, responseBody?: unknown) {
    super(message);
    this.name = 'AiqClientError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

const headers = (): Record<string, string> => {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-aiq-mode': 'headless',
  };
  if (config.aiqAuthToken) {
    h.authorization = `Bearer ${config.aiqAuthToken}`;
  }
  return h;
};

const baseUrl = (): string => {
  if (!config.aiqServerUrl) {
    throw new AiqClientError('AIQ_SERVER_URL is not configured', 0);
  }
  return config.aiqServerUrl.replace(/\/+$/, '');
};

// Default 30s timeout for short-lived AI-Q endpoints (health, agents, status,
// report, state, cancel). `submitJob` overrides with a longer cap because
// queue intake can stall during AI-Q cold start or backlog, and a hard 30s abort
// there manifests as immediate "조사 중 문제가 생겼어요" before any external
// job id is even assigned.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SUBMIT_REQUEST_TIMEOUT_MS = 120_000;

const requestJson = async <T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> => {
  const url = `${baseUrl()}${path}`;
  const response = await fetch(url, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave as null; surface raw body in error
  }
  if (!response.ok) {
    throw new AiqClientError(
      `AI-Q ${method} ${path} failed: ${response.status} ${response.statusText}`,
      response.status,
      json ?? text,
    );
  }
  return (json as T);
};

/**
 * AI-Q returns job status in lowercase ('success', 'running', …) while this
 * client's domain type and every caller compare against uppercase
 * ('SUCCESS', …). Normalize at the boundary so a successful job is never
 * mistaken for a still-running one (which previously made polling spin until
 * timeout even though the report was ready).
 */
const normalizeStatusResponse = (res: AiqJobStatusResponse): AiqJobStatusResponse => ({
  ...res,
  status: String(res.status ?? '').toUpperCase() as AiqJobStatus,
});

const toCamel = <T>(rawIn: Record<string, unknown> | null | undefined): T => {
  // Lightweight snake_case → camelCase for the few fields we care about.
  if (!rawIn) return rawIn as unknown as T;
  const raw = rawIn;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[camel] = v;
  }
  return out as unknown as T;
};

export const checkHealth = async (): Promise<{ ok: boolean; raw: unknown }> => {
  try {
    const data = await requestJson<Record<string, unknown>>('GET', '/health');
    // AI-Q /health returns { status: 'healthy' }; accept both for forward-compat.
    const s = data?.status as string | undefined;
    return { ok: s === 'healthy' || s === 'ok', raw: data };
  } catch (error) {
    return { ok: false, raw: error instanceof AiqClientError ? error.responseBody : String(error) };
  }
};

export const listAgents = async (): Promise<Array<{ agentType: string; description: string }>> => {
  const data = await requestJson<{ agents?: Array<{ agent_type: string; description: string }> }>(
    'GET',
    '/v1/jobs/async/agents',
  );
  return (data.agents ?? []).map((row) => ({
    agentType: row.agent_type,
    description: row.description,
  }));
};

export const submitJob = async (input: AiqSubmitInput): Promise<AiqJobStatusResponse> => {
  const body: Record<string, unknown> = {
    agent_type: input.agentType ?? config.aiqDefaultAgentType,
    input: input.topic,
  };
  if (input.jobId) body.job_id = input.jobId;
  if (input.expirySeconds) body.expiry_seconds = input.expirySeconds;

  const raw = await requestJson<Record<string, unknown>>(
    'POST',
    '/v1/jobs/async/submit',
    body,
    SUBMIT_REQUEST_TIMEOUT_MS,
  );
  return normalizeStatusResponse(toCamel<AiqJobStatusResponse>(raw));
};

export const getJobStatus = async (jobId: string): Promise<AiqJobStatusResponse> => {
  const raw = await requestJson<Record<string, unknown>>('GET', `/v1/jobs/async/job/${encodeURIComponent(jobId)}`);
  return normalizeStatusResponse(toCamel<AiqJobStatusResponse>(raw));
};

export const getJobReport = async (jobId: string): Promise<AiqJobReport> => {
  const raw = await requestJson<Record<string, unknown>>(
    'GET',
    `/v1/jobs/async/job/${encodeURIComponent(jobId)}/report`,
  );
  return toCamel<AiqJobReport>(raw);
};

export const getJobState = async (jobId: string): Promise<AiqJobState> => {
  const raw = await requestJson<Record<string, unknown>>(
    'GET',
    `/v1/jobs/async/job/${encodeURIComponent(jobId)}/state`,
  );
  return toCamel<AiqJobState>(raw);
};

export const cancelJob = async (jobId: string): Promise<AiqJobStatusResponse> => {
  const raw = await requestJson<Record<string, unknown>>(
    'POST',
    `/v1/jobs/async/job/${encodeURIComponent(jobId)}/cancel`,
  );
  return normalizeStatusResponse(toCamel<AiqJobStatusResponse>(raw));
};

export const isTerminalStatus = (status: AiqJobStatus): boolean =>
  status === 'SUCCESS' || status === 'FAILURE' || status === 'INTERRUPTED';

/**
 * Poll until terminal or timeout. Calls onProgress on every poll (optional).
 * Resolves to the final status response; report retrieval is the caller's
 * responsibility (separate /report call).
 */
export const pollUntilTerminal = async (
  jobId: string,
  opts?: {
    intervalMs?: number;
    timeoutMs?: number;
    onProgress?: (status: AiqJobStatusResponse) => void;
  },
): Promise<AiqJobStatusResponse> => {
  const intervalMs = opts?.intervalMs ?? config.aiqPollIntervalMs;
  const timeoutMs = opts?.timeoutMs ?? config.aiqPollTimeoutMs;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const status = await getJobStatus(jobId);
    opts?.onProgress?.(status);
    if (isTerminalStatus(status.status)) return status;
    if (Date.now() > deadline) {
      throw new AiqClientError(`AI-Q job ${jobId} polling timed out after ${timeoutMs}ms`, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
