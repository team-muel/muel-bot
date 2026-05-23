import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Stage 5 — agent action audit log.
 *
 * Records every Muel-as-agent turn across triggers (mention, reply, reaction,
 * allowlist channel, slash command). Links to the underlying LLM event row in
 * muel_ai_events when one exists. Status reflects the agent decision, not the
 * downstream LLM call:
 *   - responded: agent produced a reply.
 *   - rate_limited: rate-limit / concurrency rejected before LLM call.
 *   - denied: trigger condition didn't qualify (kept for forward use; reactions
 *     against non-Muel messages, etc.).
 *   - error: agent threw / Discord post failed.
 *
 * Write tools (post_message, add_reaction, edit_message) are deferred to a
 * later phase. When introduced, each tool call will produce its own audit row.
 */

export type AgentTriggerSource =
  | 'mention'
  | 'reply_to_muel'
  | 'reaction'
  | 'allowlist_channel'
  | 'slash_command';

export type AgentActionStatus = 'responded' | 'rate_limited' | 'denied' | 'error';

export type AgentActionInput = {
  triggerSource: AgentTriggerSource;
  triggerDetail?: string | null;
  status: AgentActionStatus;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
  discordUserId?: string | null;
  targetMessageId?: string | null;
  responseMessageId?: string | null;
  aiEventId?: string | null;
  metadata?: Record<string, unknown>;
};

export const logMuelAgentAction = async (
  supabase: SupabaseClient,
  input: AgentActionInput,
): Promise<void> => {
  const { error } = await supabase.from('muel_agent_actions').insert({
    trigger_source: input.triggerSource,
    trigger_detail: input.triggerDetail ?? null,
    status: input.status,
    discord_guild_id: input.discordGuildId ?? null,
    discord_channel_id: input.discordChannelId ?? null,
    discord_user_id: input.discordUserId ?? null,
    target_message_id: input.targetMessageId ?? null,
    response_message_id: input.responseMessageId ?? null,
    ai_event_id: input.aiEventId ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    console.warn('[muel-agent-actions] insert failed', error);
  }
};
