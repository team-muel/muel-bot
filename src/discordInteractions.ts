import { createPublicKey, verify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';
import { getSupabaseClient } from './supabase.js';
import { enqueueJob } from './muelJobs.js';
import {
  OPTION_ACTION,
  OPTION_KIND,
  OPTION_LINK,
  SUBSCRIBE_ACTION_ADD,
  SUBSCRIBE_ACTION_LIST,
  SUBSCRIBE_ACTION_REMOVE,
} from './subscribe.js';
import { getDeferredEphemeralInteractionResponse } from './jobWorker.js';

const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const EPHEMERAL_FLAG = 1 << 6;

const HELP_TEXT = [
  '**Muel에서 사용할 수 있는 입구**',
  '',
  `Muel Hub: <${config.hubUrl}>`,
  `일기: <${config.hubUrl}/weave>`,
  '',
  '명령어: /구독 /도움말 /ping',
].join('\n');

const readRawBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const json = (response: ServerResponse, status: number, payload: Record<string, unknown>) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
};

const toEd25519SpkiDer = (hexKey: string): Buffer =>
  Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hexKey, 'hex')]);

const verifyDiscordSignature = (body: Buffer, signature: string, timestamp: string): boolean => {
  const publicKeys = [config.discordApplicationPublicKey, config.gomdoriApplicationPublicKey].filter(Boolean) as string[];
  if (publicKeys.length === 0) return false;

  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), body]);
  const signatureBytes = Buffer.from(signature, 'hex');

  return publicKeys.some((publicKeyHex) => {
    try {
      const keyObject = createPublicKey({ key: toEd25519SpkiDer(publicKeyHex), format: 'der', type: 'spki' });
      return verify(null, message, keyObject, signatureBytes);
    } catch {
      return false;
    }
  });
};

const getStringOption = (interaction: any, optionName: string): string | null => {
  const options = Array.isArray(interaction.data?.options) ? interaction.data.options : [];
  const match = options.find((option: any) => option?.name === optionName);
  return typeof match?.value === 'string' ? match.value.trim() : null;
};

export const handleDiscordInteractions = async (request: IncomingMessage, response: ServerResponse) => {
  if (!config.enableHttpInteractions) {
    json(response, 404, { error: 'http_interactions_disabled' });
    return;
  }

  const signature = request.headers['x-signature-ed25519'];
  const timestamp = request.headers['x-signature-timestamp'];
  if (typeof signature !== 'string' || typeof timestamp !== 'string') {
    json(response, 401, { error: 'missing_signature' });
    return;
  }

  const rawBody = await readRawBody(request);
  if (!verifyDiscordSignature(rawBody, signature, timestamp)) {
    json(response, 401, { error: 'invalid_signature' });
    return;
  }

  const interaction = JSON.parse(rawBody.toString('utf8'));
  if (interaction.type === INTERACTION_PING) {
    json(response, 200, { type: 1 });
    return;
  }

  if (interaction.type !== INTERACTION_APPLICATION_COMMAND) {
    json(response, 200, {
      type: 4,
      data: { content: '아직 처리하지 않는 interaction 타입이야.', flags: EPHEMERAL_FLAG },
    });
    return;
  }

  const commandName = interaction.data?.name;
  if (commandName === 'ping') {
    json(response, 200, { type: 4, data: { content: 'pong', flags: EPHEMERAL_FLAG } });
    return;
  }

  if (commandName === '도움말') {
    json(response, 200, { type: 4, data: { content: HELP_TEXT, flags: EPHEMERAL_FLAG } });
    return;
  }

  if (commandName === '게임') {
    json(response, 200, {
      type: 4,
      data: { content: `🐻 Gomdori — 마피아 게임\n\n${config.hubUrl}/game`, flags: EPHEMERAL_FLAG },
    });
    return;
  }

  if (commandName === '구독') {
    const action = getStringOption(interaction, OPTION_ACTION);
    const kind = getStringOption(interaction, OPTION_KIND);
    const link = getStringOption(interaction, OPTION_LINK);

    const normalizedAction =
      action === SUBSCRIBE_ACTION_ADD || action === SUBSCRIBE_ACTION_REMOVE || action === SUBSCRIBE_ACTION_LIST
        ? action
        : SUBSCRIBE_ACTION_LIST;

    await enqueueJob(
      getSupabaseClient(),
      'discord_interaction_subscribe',
      {
        applicationId: interaction.application_id,
        token: interaction.token,
        guildId: interaction.guild_id ?? null,
        channelId: interaction.channel_id ?? null,
        userId: interaction.member?.user?.id ?? interaction.user?.id ?? '',
        action: normalizedAction,
        kind: kind === 'videos' || kind === 'posts' ? kind : undefined,
        link: link || undefined,
      },
      `discord_interaction_subscribe:${interaction.id}`,
    );

    json(response, 200, getDeferredEphemeralInteractionResponse());
    return;
  }

  json(response, 200, {
    type: 4,
    data: { content: '지금 사용할 수 있는 명령어는 /도움말, /구독, /ping 이야.', flags: EPHEMERAL_FLAG },
  });
};
