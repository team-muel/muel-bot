import { getArchivistStatus } from './archivist/index.js';
import { config } from './config.js';
import { getCommandRegistrationStatus } from './discordCommandRegistry.js';
import { getJobWorkerStatus } from './jobWorker.js';
import { getSupabaseRestrictionStatus } from './serviceRestriction.js';
import { getYouTubeMonitorStatus } from './youtubeMonitor.js';

export type RuntimeStatusInputs = {
  muelReady: boolean;
  muelLoginError: string | null;
  gomdoriConfigured: boolean;
  gomdoriReady: boolean;
  gomdoriLoginError: string | null;
};

export const buildRuntimeStatus = (inputs: RuntimeStatusInputs) => {
  const youtubeMonitor = getYouTubeMonitorStatus();
  const jobWorker = getJobWorkerStatus();
  const commands = getCommandRegistrationStatus();
  const supabaseRestriction = getSupabaseRestrictionStatus();
  const archivist = getArchivistStatus();
  const degradedReasons: string[] = [];

  if (inputs.muelLoginError) degradedReasons.push(`muel_login:${inputs.muelLoginError}`);
  if (inputs.gomdoriConfigured && inputs.gomdoriLoginError) {
    degradedReasons.push(`gomdori_login:${inputs.gomdoriLoginError}`);
  }
  if (!inputs.muelReady) degradedReasons.push('muel_not_ready');
  if (inputs.gomdoriConfigured && !inputs.gomdoriReady) degradedReasons.push('gomdori_not_ready');
  if (jobWorker.lastError) degradedReasons.push(`job_worker:${jobWorker.lastError}`);
  if (config.enableYoutubeMonitor && youtubeMonitor.lastTickStatus === 'error') {
    degradedReasons.push(`youtube_monitor:${youtubeMonitor.lastTickMessage ?? 'unknown'}`);
  }
  if (!config.googleGenerativeAiApiKey && !config.nvidiaApiKey) degradedReasons.push('llm_not_configured');
  if (commands.lastError) degradedReasons.push(`command_registration:${commands.lastError}`);
  if (supabaseRestriction.active) {
    degradedReasons.push(`supabase_data_api:${supabaseRestriction.reason ?? 'restricted'}`);
  }
  if (archivist.enabled && !archivist.ready) {
    degradedReasons.push(`archivist:${archivist.lastError ?? 'not_ready'}`);
  }

  return {
    ok: degradedReasons.length === 0,
    degradedReasons,
    youtubeMonitor,
    jobWorker,
    archivist,
    commands,
    supabaseRestriction,
  };
};

export type RuntimeStatus = ReturnType<typeof buildRuntimeStatus>;
