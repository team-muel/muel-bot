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

export type RuntimeStatusSnapshot = RuntimeStatusInputs & {
  enableYoutubeMonitor: boolean;
  llmConfigured: boolean;
  youtubeMonitor: ReturnType<typeof getYouTubeMonitorStatus>;
  jobWorker: ReturnType<typeof getJobWorkerStatus>;
  commands: ReturnType<typeof getCommandRegistrationStatus>;
  supabaseRestriction: ReturnType<typeof getSupabaseRestrictionStatus>;
  archivist: ReturnType<typeof getArchivistStatus>;
};

export const collectRuntimeStatus = (inputs: RuntimeStatusInputs): RuntimeStatusSnapshot => ({
  ...inputs,
  enableYoutubeMonitor: config.enableYoutubeMonitor,
  llmConfigured: Boolean(config.googleGenerativeAiApiKey || config.nvidiaApiKey),
  youtubeMonitor: getYouTubeMonitorStatus(),
  jobWorker: getJobWorkerStatus(),
  commands: getCommandRegistrationStatus(),
  supabaseRestriction: getSupabaseRestrictionStatus(),
  archivist: getArchivistStatus(),
});

export const buildRuntimeStatus = (snapshot: RuntimeStatusSnapshot) => {
  const degradedReasons: string[] = [];

  if (snapshot.muelLoginError) degradedReasons.push('muel_login_error');
  if (snapshot.gomdoriConfigured && snapshot.gomdoriLoginError) {
    degradedReasons.push('gomdori_login_error');
  }
  if (!snapshot.muelReady) degradedReasons.push('muel_not_ready');
  if (snapshot.gomdoriConfigured && !snapshot.gomdoriReady) degradedReasons.push('gomdori_not_ready');
  if (snapshot.jobWorker.lastError) degradedReasons.push('job_worker_error');
  if (snapshot.enableYoutubeMonitor && snapshot.youtubeMonitor.lastTickStatus === 'error') {
    degradedReasons.push('youtube_monitor_error');
  }
  if (!snapshot.llmConfigured) degradedReasons.push('llm_not_configured');
  if (snapshot.commands.lastError) degradedReasons.push('command_registration_error');
  if (snapshot.supabaseRestriction.active) {
    degradedReasons.push('supabase_data_api_restricted');
  }
  if (snapshot.archivist.enabled && !snapshot.archivist.ready) {
    degradedReasons.push('archivist_not_ready');
  }

  return {
    ok: degradedReasons.length === 0,
    degradedReasons,
    youtubeMonitor: snapshot.youtubeMonitor,
    jobWorker: snapshot.jobWorker,
    archivist: snapshot.archivist,
    commands: snapshot.commands,
    supabaseRestriction: snapshot.supabaseRestriction,
  };
};

export type RuntimeStatus = ReturnType<typeof buildRuntimeStatus>;
