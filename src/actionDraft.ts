import { generateObject } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPrimaryTextModel } from './modelRegistry.js';
import { repairJsonText } from './aiRepair.js';
import { classifyAiError, logMuelBackgroundAiEvent } from './muelAiEvents.js';

const ActionDraftSchema = z.object({
  action: z.enum(['none', 'hub_activate', 'hub_deactivate']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(160).optional(),
});

export type MuelActionDraft = z.infer<typeof ActionDraftSchema>;

const ACTION_DRAFT_PROMPT = [
  'Classify whether a Discord user is explicitly asking Muel to prepare a reversible server action.',
  '',
  'Allowed actions:',
  '- hub_activate: the user explicitly asks to turn on/activate/enable Muel Hub in this channel.',
  '- hub_deactivate: the user explicitly asks to turn off/deactivate/disable Muel Hub in this channel.',
  '- none: anything else, including questions about status, summaries, subscriptions, jokes, ambiguous requests, or requests that need extra details.',
  '',
  'Rules:',
  '- Be conservative. If the user is asking what the hub is, whether it is active, or what commands exist, choose none.',
  '- Do not classify YouTube subscription add/remove here. Those need more structured UI and are not enabled in this draft path.',
  '- The classifier only drafts an action. It never executes anything.',
  '- Output strict JSON matching the schema.',
].join('\n');

export const classifyActionDraft = async (
  supabase: SupabaseClient,
  args: {
    userText: string;
    chatId?: string | null;
    discordGuildId?: string | null;
    discordChannelId?: string | null;
    discordUserId?: string | null;
  },
): Promise<MuelActionDraft | null> => {
  const text = args.userText.trim();
  if (!text) return null;

  const model = getPrimaryTextModel('router');
  if (!model) return null;

  const startedAt = Date.now();
  try {
    const { object, usage, providerMetadata } = await generateObject({
      model: model.model,
      schema: ActionDraftSchema,
      experimental_repairText: repairJsonText,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
      temperature: 0,
      prompt: `${ACTION_DRAFT_PROMPT}\n\nUser text:\n"""\n${text}\n"""`,
    });

    void logMuelBackgroundAiEvent(supabase, {
      source: 'discord',
      status: 'success',
      taskType: 'action_draft',
      resolvedModel: { provider: model.provider, modelId: model.modelId, task: model.task },
      startedAt,
      usage,
      providerMetadata,
      chatId: args.chatId ?? null,
      metadata: {
        action: object.action,
        confidence: object.confidence,
        reason: object.reason ?? null,
        discordGuildId: args.discordGuildId ?? null,
        discordChannelId: args.discordChannelId ?? null,
        discordUserId: args.discordUserId ?? null,
      },
    });

    return object;
  } catch (error) {
    // 스키마 매칭 실패(AI_NoObjectGeneratedError)는 분류 실패일 뿐 — fallback 으로 적재해
    // sentinel 임계 노이즈에서 뺀다(router/summary/extract 와 일관). 진짜 인프라 에러만 error.
    const c = classifyAiError(error);
    void logMuelBackgroundAiEvent(supabase, {
      source: 'discord',
      status: c.status,
      taskType: 'action_draft',
      resolvedModel: { provider: model.provider, modelId: model.modelId, task: model.task },
      startedAt,
      chatId: args.chatId ?? null,
      errorClass: c.errorClass,
      errorMessage: c.errorMessage.slice(0, 240),
      fallbackReason: c.isSchemaFailure ? 'action_draft_schema_match_failed' : null,
      metadata: {
        discordGuildId: args.discordGuildId ?? null,
        discordChannelId: args.discordChannelId ?? null,
        discordUserId: args.discordUserId ?? null,
      },
    });
    return null;
  }
};
