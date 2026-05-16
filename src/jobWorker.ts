import type { Client } from 'discord.js';
import { ChannelType } from 'discord.js';
import { getSupabaseClient } from './supabase.js';
import { processMemoryJob } from './memoryWorker.js';
import { runYouTubeMonitorTick } from './youtubeMonitor.js';
import {
  createYouTubeSubscription,
  deleteYouTubeSubscription,
  listYouTubeSubscriptions,
  type YouTubeSubscriptionKind,
} from './youtubeSubscriptionStore.js';

type JobRow = {
  id: string;
  type: string;
  payload: any;
  attempts: number;
};

type SubscribeInteractionPayload = {
  applicationId: string;
  token: string;
  guildId: string | null;
  channelId: string | null;
  userId: string;
  action: 'list' | 'add' | 'remove';
  kind?: YouTubeSubscriptionKind;
  link?: string;
};

type JobWorkerStatus = {
  running: boolean;
  pollIntervalMs: number;
  lastLoopStartedAt: string | null;
  lastLoopFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastClaimedJobs: number;
  lastProcessedJobId: string | null;
};

const POLL_INTERVAL_MS = 5_000;
const INTERACTION_EPHEMERAL_FLAG = 1 << 6;

const workerStatus: JobWorkerStatus = {
  running: false,
  pollIntervalMs: POLL_INTERVAL_MS,
  lastLoopStartedAt: null,
  lastLoopFinishedAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastClaimedJobs: 0,
  lastProcessedJobId: null,
};

let workerClient: Client | null = null;

const isValidSubscribeChannelType = (t: number): boolean =>
  t === ChannelType.GuildText ||
  t === ChannelType.GuildAnnouncement ||
  t === ChannelType.PublicThread ||
  t === ChannelType.PrivateThread ||
  t === ChannelType.AnnouncementThread;

const patchOriginalInteractionResponse = async (
  applicationId: string,
  token: string,
  body: Record<string, unknown>,
) => {
  const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Discord interaction webhook failed: ${response.status} ${await response.text()}`);
  }
};

const buildSubscribeResponse = (title: string, text: string) => ({
  content: `**${title}**\n${text}`.slice(0, 1900),
});

const handleSubscribeInteraction = async (payload: SubscribeInteractionPayload) => {
  if (!payload.guildId) {
    await patchOriginalInteractionResponse(payload.applicationId, payload.token, buildSubscribeResponse('구독', '이 명령어는 서버에서만 사용할 수 있어.'));
    return;
  }

  try {
    if (payload.action === 'list') {
      const rows = await listYouTubeSubscriptions({ guildId: payload.guildId });
      const text = rows.length === 0
        ? '등록된 YouTube 구독이 없어.'
        : rows.slice(0, 20).map((row) => `#${row.id} ${row.url} -> ${row.channel_id ?? '-'}`).join('\n');
      await patchOriginalInteractionResponse(payload.applicationId, payload.token, buildSubscribeResponse('구독 목록', text));
      return;
    }

    if (!payload.channelId || !payload.kind || !payload.link) {
      await patchOriginalInteractionResponse(payload.applicationId, payload.token, buildSubscribeResponse('구독', '종류와 링크를 같이 보내줘.'));
      return;
    }

    if (!workerClient) {
      throw new Error('Discord client is unavailable for subscription jobs');
    }

    const channel = await workerClient.channels.fetch(payload.channelId);
    if (!channel || !('type' in channel) || !isValidSubscribeChannelType(channel.type)) {
      await patchOriginalInteractionResponse(payload.applicationId, payload.token, buildSubscribeResponse('구독', '텍스트 채널이나 스레드에서만 사용할 수 있어.'));
      return;
    }

    if (payload.action === 'add') {
      const result = await createYouTubeSubscription({
        userId: payload.userId,
        guildId: payload.guildId,
        discordChannelId: payload.channelId,
        channelInput: payload.link,
        kind: payload.kind,
      });
      await patchOriginalInteractionResponse(
        payload.applicationId,
        payload.token,
        buildSubscribeResponse('구독 등록', `${result.created ? '등록했어' : '이미 있어'}: ${result.channelId} -> <#${payload.channelId}>`)
      );
      return;
    }

    const result = await deleteYouTubeSubscription({
      guildId: payload.guildId,
      discordChannelId: payload.channelId,
      channelInput: payload.link,
      kind: payload.kind,
    });
    await patchOriginalInteractionResponse(
      payload.applicationId,
      payload.token,
      buildSubscribeResponse('구독 제거', result.deleted ? `제거했어: ${result.channelId}` : `지울 구독이 없어: ${result.channelId}`)
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await patchOriginalInteractionResponse(payload.applicationId, payload.token, buildSubscribeResponse('구독 실패', reason));
  }
};

const processJob = async (job: JobRow) => {
  if (job.type === 'extract_memory') {
    await processMemoryJob(job);
    return;
  }

  if (job.type === 'sync_youtube_sources') {
    if (!workerClient) throw new Error('Discord client is unavailable for youtube sync jobs');
    await runYouTubeMonitorTick(workerClient);
    return;
  }

  if (job.type === 'discord_interaction_subscribe') {
    await handleSubscribeInteraction(job.payload as SubscribeInteractionPayload);
    return;
  }

  throw new Error(`Unsupported job type: ${job.type}`);
};

export const configureJobWorker = (client: Client) => {
  workerClient = client;
};

export const runJobWorkerLoop = async () => {
  const supabase = getSupabaseClient();
  workerStatus.running = true;
  console.log('[jobs] Worker started');

  while (true) {
    workerStatus.lastLoopStartedAt = new Date().toISOString();
    try {
      const { data: jobs, error } = await supabase.rpc('claim_pending_jobs', {
        p_worker_id: 'app-worker-node',
        p_limit: 5,
      });

      if (error) {
        workerStatus.lastErrorAt = new Date().toISOString();
        workerStatus.lastError = error.message || String(error);
        workerStatus.lastClaimedJobs = 0;
      } else if (jobs && jobs.length > 0) {
        workerStatus.lastClaimedJobs = jobs.length;
        for (const job of jobs as JobRow[]) {
          try {
            await processJob(job);
            await supabase.rpc('complete_job', { p_job_id: job.id });
            workerStatus.lastProcessedJobId = job.id;
            workerStatus.lastSuccessAt = new Date().toISOString();
            workerStatus.lastError = null;
          } catch (jobErr: any) {
            workerStatus.lastErrorAt = new Date().toISOString();
            workerStatus.lastError = jobErr?.message || 'Unknown error';
            console.error(`[jobs] job ${job.id} failed`, jobErr);
            await supabase.rpc('fail_job', {
              p_job_id: job.id,
              p_error: jobErr?.message || 'Unknown error',
              p_retry_delay_seconds: 60,
              p_max_attempts: 5,
            });
          }
        }
      } else {
        workerStatus.lastClaimedJobs = 0;
        workerStatus.lastSuccessAt = new Date().toISOString();
        workerStatus.lastError = null;
      }
    } catch (error) {
      workerStatus.lastErrorAt = new Date().toISOString();
      workerStatus.lastError = error instanceof Error ? error.message : String(error);
      console.error('[jobs] worker loop error', error);
    } finally {
      workerStatus.lastLoopFinishedAt = new Date().toISOString();
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};

export const getJobWorkerStatus = (): JobWorkerStatus => ({ ...workerStatus });

export const getDeferredEphemeralInteractionResponse = () => ({
  type: 5,
  data: { flags: INTERACTION_EPHEMERAL_FLAG },
});
