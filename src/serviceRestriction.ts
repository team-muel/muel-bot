import { errorDetail } from './errorFlavor.js';

export type SupabaseRestrictionStatus = {
  active: boolean;
  detectedAt: string | null;
  lastDetectedAt: string | null;
  nextProbeAt: string | null;
  consecutiveProbeFailures: number;
  retryDelayMs: number;
  reason: string | null;
};

type RestrictionCircuitOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export class SupabaseRestrictionCircuit {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private status: SupabaseRestrictionStatus;

  constructor(options: RestrictionCircuitOptions = {}) {
    this.baseDelayMs = Math.max(1, options.baseDelayMs ?? 60_000);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 15 * 60_000);
    this.status = this.emptyStatus();
  }

  private emptyStatus(): SupabaseRestrictionStatus {
    return {
      active: false,
      detectedAt: null,
      lastDetectedAt: null,
      nextProbeAt: null,
      consecutiveProbeFailures: 0,
      retryDelayMs: 0,
      reason: null,
    };
  }

  recordRestriction(error: unknown, now = Date.now()): SupabaseRestrictionStatus {
    const currentNextProbe = this.status.nextProbeAt
      ? Date.parse(this.status.nextProbeAt)
      : Number.NaN;
    const isNewProbeFailure = !this.status.active
      || !Number.isFinite(currentNextProbe)
      || now >= currentNextProbe;
    const consecutiveProbeFailures = isNewProbeFailure
      ? this.status.consecutiveProbeFailures + 1
      : this.status.consecutiveProbeFailures;
    const retryDelayMs = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * (2 ** Math.max(0, consecutiveProbeFailures - 1)),
    );
    const nowIso = new Date(now).toISOString();

    this.status = {
      active: true,
      detectedAt: this.status.detectedAt ?? nowIso,
      lastDetectedAt: nowIso,
      nextProbeAt: isNewProbeFailure
        ? new Date(now + retryDelayMs).toISOString()
        : this.status.nextProbeAt,
      consecutiveProbeFailures,
      retryDelayMs: isNewProbeFailure ? retryDelayMs : this.status.retryDelayMs,
      reason: errorDetail(error).slice(0, 500),
    };
    return this.getStatus();
  }

  recordSuccess(): void {
    this.status = this.emptyStatus();
  }

  isOpen(): boolean {
    return this.status.active;
  }

  retryDelay(now = Date.now()): number {
    if (!this.status.active || !this.status.nextProbeAt) return 0;
    const nextProbeAt = Date.parse(this.status.nextProbeAt);
    return Number.isFinite(nextProbeAt) ? Math.max(0, nextProbeAt - now) : this.baseDelayMs;
  }

  getStatus(): SupabaseRestrictionStatus {
    return { ...this.status };
  }
}

/**
 * Supabase Fair Use restrictions are returned by PostgREST as plain objects,
 * usually with a prose message and no stable error code. Keep this predicate
 * narrow: schema bugs and ordinary database failures must still surface.
 */
export const isSupabaseQuotaRestriction = (error: unknown): boolean => {
  const detail = errorDetail(error);
  return /exceed_db_size_quota|service for this project is restricted|payment required/i.test(detail);
};

const restrictionCircuit = new SupabaseRestrictionCircuit();

export const recordSupabaseQuotaRestriction = (
  error: unknown,
): SupabaseRestrictionStatus => restrictionCircuit.recordRestriction(error);

export const recordSupabaseDataApiSuccess = (): void => {
  restrictionCircuit.recordSuccess();
};

export const isSupabaseDataApiRestricted = (): boolean => restrictionCircuit.isOpen();

export const getSupabaseRestrictionRetryDelay = (): number => restrictionCircuit.retryDelay();

export const getSupabaseRestrictionStatus = (): SupabaseRestrictionStatus => (
  restrictionCircuit.getStatus()
);
