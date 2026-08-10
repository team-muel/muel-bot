import type { Client } from 'discord.js';
import { config } from './config.js';
import { startArchivist } from './archivist/index.js';
import { configureJobWorker, runJobWorkerLoop } from './jobWorker.js';
import { getSupabaseClient } from './supabase.js';
import { startFeedbackObserver } from './feedbackObserver.js';
import { runProviderHealthcheck } from './providerHealthcheck.js';
import { initPromptOverlays } from './promptOverlays.js';
import { runSocialEval } from './socialEval.js';
import { startProactiveScheduler } from './proactiveSpeaker.js';
import { startYouTubeMonitor } from './youtubeMonitor.js';
import { isSupabaseDataApiRestricted } from './serviceRestriction.js';

/**
 * Start background services in dependency order after Discord is ready.
 *
 * Archivist owns the first Data API preflight. Awaiting it lets a Fair Use 402
 * open the shared circuit before the remaining pollers can create a startup
 * request burst. Every service remains independently failure-isolated.
 */
export const startRuntimeServices = async (client: Client<true>): Promise<void> => {
  configureJobWorker(client);
  await startArchivist(client);

  const supabase = getSupabaseClient();
  // This is also the fallback startup probe when Archivist is disabled. It is
  // awaited so one 402 opens the circuit before other DB-backed services run.
  await initPromptOverlays(supabase).catch((error) => {
    console.warn('[prompt-overlays] init failed', error);
  });

  if (config.enableYoutubeMonitor) startYouTubeMonitor(client);
  startProactiveScheduler(client, supabase);
  startFeedbackObserver(client, supabase);

  if (!isSupabaseDataApiRestricted()) {
    void runSocialEval(supabase).catch((error) => {
      console.warn('[social-eval] run failed', error);
    });
  }

  void runProviderHealthcheck(supabase).catch((error) => {
    console.warn('[provider-healthcheck] crashed', error);
  });

  if (config.enableJobWorker) {
    void runJobWorkerLoop().catch((error) => {
      console.error('[jobs] worker loop crashed', error);
    });
  }
};
