import type { Client } from 'discord.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import type { MuelRenderablePart, CardSection } from './rendering/types.js';
import {
  AiqClientError,
  getJobStatus,
  getJobReport,
  getJobState,
  submitJob,
  type AiqJobStatusResponse,
} from './aiqClient.js';
import { getSupabaseClient } from './supabase.js';
import { config } from './config.js';
import { enqueueJob } from './muelJobs.js';

/**
 * jobWorker handler for 'research_user_dm' job type. Submitted from
 * researchEnrich button → processed here. Owns:
 *   - calling AI-Q submit
 *   - short polling ticks + report fetch
 *   - rendering the DM card
 *   - DM delivery
 *   - ephemeral follow-up fallback via interaction webhook
 *   - muel_research_jobs status updates throughout
 */

export type ResearchUserDmPayload = {
  researchJobRowId: string;
  topic: string;
  agentType: string;
  requesterUserId: string;
  guildId: string | null;
  channelId: string;
  targetMessageId: string;
  originTable: string;
  originId: string;
  originMessageJumpUrl?: string | null;
  interactionToken?: string | null;
  interactionApplicationId?: string | null;
};

export type ResearchUserDmPollPayload = ResearchUserDmPayload & {
  externalJobId?: string | null;
};

const reportExcerpt = (report: string, max = 500): string => {
  if (!report) return '';
  return report.length <= max ? report : `${report.slice(0, max - 1).trimEnd()}…`;
};

/**
 * Parse AI-Q markdown report into structured sections. Falls back to single
 * body block if no markdown headers are present.
 */
const reportToSections = (report: string): { intro: string; sections: CardSection[] } => {
  if (!report) return { intro: '', sections: [] };
  // Split on level-2 headers (## ). AI-Q deep research reports typically use
  // these for "Introduction", "Findings", "Sources", etc.
  const blocks = report.split(/\n(?=##\s)/);
  const intro = blocks[0]?.startsWith('##') ? '' : (blocks.shift() ?? '').trim();
  const sections: CardSection[] = [];
  for (const block of blocks) {
    const lineBreak = block.indexOf('\n');
    const header = (lineBreak === -1 ? block : block.slice(0, lineBreak)).replace(/^##\s+/, '').trim();
    const content = (lineBreak === -1 ? '' : block.slice(lineBreak + 1)).trim();
    if (header) sections.push({ header, content });
  }
  return { intro, sections };
};

const buildDmRenderable = (args: {
  topic: string;
  report: string;
  sourceCited?: number;
  originMessageJumpUrl?: string | null;
}): MuelRenderablePart[] => {
  const { intro, sections } = reportToSections(args.report);
  const richSections = sections.slice(0, 8).map((s) => ({
    header: s.header,
    content: s.content,
  }));
  // 사용자는 Muel이 조사한 것으로 인지하므로 외부 시스템(AI-Q) 명칭은 footer에서 제외.
  const footerParts = ['Muel 리서치'];
  if (typeof args.sourceCited === 'number') footerParts.push(`인용 ${args.sourceCited}개`);
  return [
    {
      type: 'rich-card',
      tone: 'muel',
      title: '리서치 결과',
      subtitle: args.topic.length > 100 ? `${args.topic.slice(0, 99)}…` : args.topic,
      body: intro || undefined,
      sections: richSections,
      footer: footerParts.join(' · '),
      linkButton: args.originMessageJumpUrl
        ? { label: '원본으로 돌아가기', url: args.originMessageJumpUrl }
        : undefined,
    },
  ];
};

const followUpEphemeral = async (
  applicationId: string,
  token: string,
  content: string,
): Promise<boolean> => {
  try {
    const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900), flags: 1 << 6 }),
    });
    return response.ok;
  } catch (err) {
    console.warn('[research-deliver] follow-up failed', err);
    return false;
  }
};

const terminalStatuses = ['success', 'failure', 'cancelled', 'timeout'];

const schedulePoll = async (
  payload: ResearchUserDmPollPayload,
  delayMs = config.aiqPollIntervalMs,
): Promise<void> => {
  const runAfter = new Date(Date.now() + delayMs).toISOString();
  await enqueueJob(
    getSupabaseClient(),
    'research_user_dm_poll',
    payload,
    `research_user_dm_poll:${payload.researchJobRowId}:${runAfter}`,
    runAfter,
  );
};

const durationFrom = (createdAt: string | null | undefined, fallbackStartedAt: number): number =>
  Date.now() - (createdAt ? Date.parse(createdAt) : fallbackStartedAt);

const failResearchRow = async (
  payload: ResearchUserDmPayload,
  args: {
    status: 'failure' | 'timeout' | 'cancelled';
    errorClass: string;
    errorMessage: string;
    startedAt: number;
    createdAt?: string | null;
  },
): Promise<void> => {
  const supabase = getSupabaseClient();
  await supabase
    .from('muel_research_jobs')
    .update({
      status: args.status,
      error_class: args.errorClass,
      error_message: args.errorMessage.slice(0, 240),
      completed_at: new Date().toISOString(),
      duration_ms: durationFrom(args.createdAt, args.startedAt),
    })
    .eq('id', payload.researchJobRowId);

  if (payload.interactionApplicationId && payload.interactionToken) {
    let userMsg: string;
    if (args.status === 'timeout') {
      userMsg = '조사가 너무 오래 걸려서 멈췄어요. 잠시 뒤에 다시 시도해주세요.';
    } else if (args.errorClass === 'AiqClientError(0)') {
      userMsg = '조사를 시작하지 못했어요. 잠시 뒤에 다시 시도해주세요.';
    } else {
      userMsg = '조사 중 문제가 생겼어요. 잠시 뒤에 다시 시도해주세요.';
    }
    await followUpEphemeral(
      payload.interactionApplicationId,
      payload.interactionToken,
      userMsg,
    );
  }
};

export const processResearchUserDmJob = async (
  _client: Client,
  payload: ResearchUserDmPayload,
): Promise<void> => {
  const supabase = getSupabaseClient();
  const startedAt = Date.now();
  const rowId = payload.researchJobRowId;

  const { data: existing, error: rowErr } = await supabase
    .from('muel_research_jobs')
    .select('status, external_job_id, created_at')
    .eq('id', rowId)
    .single();
  if (rowErr) {
    throw new Error(`failed to fetch research job row ${rowId}: ${rowErr.message}`);
  }
  if (existing && terminalStatuses.includes(existing.status)) {
    console.log('[research-deliver] row already terminal, skipping', { rowId, status: existing.status });
    return;
  }

  await supabase
    .from('muel_research_jobs')
    .update({ status: 'running' })
    .eq('id', rowId);

  let externalJobId: string | null = existing?.external_job_id ?? null;

  try {
    if (!externalJobId) {
      const submit = await submitJob({
        topic: payload.topic,
        agentType: payload.agentType,
        expirySeconds: 60 * 60 * 24, // 1 day on AI-Q side; we control polling timeout
      });
      externalJobId = submit.jobId;
      await supabase
        .from('muel_research_jobs')
        .update({ external_job_id: externalJobId })
        .eq('id', rowId);
    }

    await schedulePoll({ ...payload, externalJobId }, config.aiqPollIntervalMs);
  } catch (error) {
    const isClient = error instanceof AiqClientError;
    const errClass = isClient ? `AiqClientError(${(error as AiqClientError).status})` : (error instanceof Error ? error.name : typeof error);
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[research-deliver] submit failed', { rowId, errClass, errMsg });

    await failResearchRow(payload, {
      status: errMsg.includes('timed out') ? 'timeout' : 'failure',
      errorClass: errClass,
      errorMessage: errMsg,
      startedAt,
      createdAt: existing?.created_at,
    });
    throw error;
  }
};

export const processResearchUserDmPollJob = async (
  client: Client,
  payload: ResearchUserDmPollPayload,
): Promise<void> => {
  const supabase = getSupabaseClient();
  const startedAt = Date.now();
  const rowId = payload.researchJobRowId;

  const { data: existing, error: rowErr } = await supabase
    .from('muel_research_jobs')
    .select('status, external_job_id, created_at')
    .eq('id', rowId)
    .single();
  if (rowErr) {
    throw new Error(`failed to fetch research job row ${rowId}: ${rowErr.message}`);
  }
  if (existing && terminalStatuses.includes(existing.status)) {
    console.log('[research-deliver] row already terminal, skipping poll', { rowId, status: existing.status });
    return;
  }

  const externalJobId = existing?.external_job_id ?? payload.externalJobId;
  if (!externalJobId) {
    throw new Error(`research row ${rowId} has no external_job_id`);
  }

  try {
    if (durationFrom(existing?.created_at, startedAt) > config.aiqPollTimeoutMs) {
      throw new AiqClientError(`AI-Q job ${externalJobId} polling timed out after ${config.aiqPollTimeoutMs}ms`, 0);
    }

    const terminal: AiqJobStatusResponse = await getJobStatus(externalJobId);
    if (terminal.status !== 'SUCCESS' && terminal.status !== 'FAILURE' && terminal.status !== 'INTERRUPTED') {
      await schedulePoll({ ...payload, externalJobId }, config.aiqPollIntervalMs);
      return;
    }

    if (terminal.status !== 'SUCCESS') {
      const errMsg = terminal.error ?? `AI-Q terminal status ${terminal.status}`;
      await supabase
        .from('muel_research_jobs')
        .update({
          status: terminal.status === 'INTERRUPTED' ? 'cancelled' : 'failure',
          error_class: 'AiqTerminal',
          error_message: errMsg.slice(0, 240),
          completed_at: new Date().toISOString(),
          duration_ms: durationFrom(existing?.created_at, startedAt),
        })
        .eq('id', rowId);

      if (payload.interactionApplicationId && payload.interactionToken) {
        await followUpEphemeral(
          payload.interactionApplicationId,
          payload.interactionToken,
          `조사가 완료되지 못했어요. (${errMsg})`,
        );
      }
      return;
    }

    // SUCCESS: fetch report + optional state for source counts.
    const report = await getJobReport(externalJobId);
    let sourceCited: number | undefined;
    let sourceFound: number | undefined;
    try {
      const state = await getJobState(externalJobId);
      sourceCited = state.artifacts?.sources?.cited;
      sourceFound = state.artifacts?.sources?.found;
    } catch {
      // optional — skip on failure
    }

    const renderable = buildDmRenderable({
      topic: payload.topic,
      report: report.report ?? '',
      sourceCited,
      originMessageJumpUrl: payload.originMessageJumpUrl,
    });
    const message = renderDiscordMessage(renderable);

    // Deliver via DM.
    let deliveryChannel: 'dm' | 'fallback_ephemeral' | 'none' = 'none';
    let deliveryMessageId: string | null = null;
    let deliveredAt: string | null = null;

    try {
      const user = await client.users.fetch(payload.requesterUserId);
      const dm = await user.createDM();
      const sent = await dm.send(message);
      deliveryChannel = 'dm';
      deliveryMessageId = sent.id;
      deliveredAt = new Date().toISOString();
    } catch (dmError) {
      console.warn('[research-deliver] DM failed', dmError);
      // Fallback to ephemeral follow-up on the original interaction (if token still valid).
      if (payload.interactionApplicationId && payload.interactionToken) {
        const ok = await followUpEphemeral(
          payload.interactionApplicationId,
          payload.interactionToken,
          [
            '리서치 결과 DM 전달이 막혔어요. 서버 멤버 DM을 허용해주시면 다음부터 DM으로 받아볼 수 있어요.',
            '',
            '아래는 결과 요약 (다른 사람에겐 안 보여요):',
            '',
            reportExcerpt(report.report ?? '', 1500),
          ].join('\n'),
        );
        if (ok) {
          deliveryChannel = 'fallback_ephemeral';
          deliveredAt = new Date().toISOString();
        }
      }
    }

    await supabase
      .from('muel_research_jobs')
      .update({
        status: 'success',
        external_job_id: externalJobId,
        completed_at: new Date().toISOString(),
        duration_ms: durationFrom(existing?.created_at, startedAt),
        report_excerpt: reportExcerpt(report.report ?? ''),
        source_found_count: sourceFound ?? null,
        source_cited_count: sourceCited ?? null,
        delivery_channel: deliveryChannel,
        delivered_at: deliveredAt,
        delivery_message_id: deliveryMessageId,
      })
      .eq('id', rowId);
  } catch (error) {
    const isClient = error instanceof AiqClientError;
    const errClass = isClient ? `AiqClientError(${(error as AiqClientError).status})` : (error instanceof Error ? error.name : typeof error);
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[research-deliver] job failed', { rowId, errClass, errMsg });

    const status = errMsg.includes('timed out') ? 'timeout' : 'failure';

    await failResearchRow(payload, {
      status,
      errorClass: errClass,
      errorMessage: errMsg,
      startedAt,
      createdAt: existing?.created_at,
    });
    throw error;
  }
};
