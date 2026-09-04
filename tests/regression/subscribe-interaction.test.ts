import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelType, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import {
  acknowledgeSubscribeCommand,
  handleFlatSubscribeCommand,
  OPTION_ACTION,
  SUBSCRIBE_ACTION_ADD,
} from '../../src/subscribe.js';
import { formatDiscordTarget } from '../../src/subscribePresentation.js';

const createInteraction = (inGuild: boolean) => {
  const events: string[] = [];
  let deferred = false;
  const edits: unknown[] = [];
  const interaction = {
    get deferred() {
      return deferred;
    },
    replied: false,
    guildId: inGuild ? 'guild-1' : null,
    guild: null,
    channel: { id: 'channel-1', type: inGuild ? ChannelType.GuildText : ChannelType.DM },
    user: { id: 'user-1' },
    inGuild: () => inGuild,
    deferReply: async (options: unknown) => {
      events.push('defer');
      deferred = true;
      if (inGuild) {
        assert.deepEqual(options, { flags: [MessageFlags.Ephemeral] });
      } else {
        assert.deepEqual(options, {});
      }
    },
    editReply: async (payload: unknown) => {
      events.push('edit');
      edits.push(payload);
    },
    reply: async () => {
      events.push('reply');
    },
    options: {
      getString: (name: string) => {
        events.push(`option:${name}`);
        return name === OPTION_ACTION ? SUBSCRIBE_ACTION_ADD : null;
      },
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, events, edits };
};

const dm = createInteraction(false);
await handleFlatSubscribeCommand(dm.interaction);
assert.equal(dm.events[0], 'defer', 'the command must acknowledge before parsing options');
assert.equal(dm.events.includes('reply'), false, 'a deferred command must finish through editReply');
assert.equal(dm.edits.length, 1, 'validation errors must replace the deferred response');

const guild = createInteraction(true);
await acknowledgeSubscribeCommand(guild.interaction);
assert.deepEqual(guild.events, ['defer'], 'guild acknowledgement remains ephemeral');

assert.equal(
  formatDiscordTarget({ id: 'channel-1', type: ChannelType.DM }),
  'Muel DM (DM)',
  'DM subscriptions should not render an invalid channel mention',
);

const store = readFileSync(join(process.cwd(), 'src', 'youtubeSubscriptionStore.ts'), 'utf8');
assert.match(store, /muelUser=/, 'DM subscription URLs must be user-scoped');
assert.match(store, /\.is\('guild_id', null\)/, 'DM subscription queries must match SQL NULL correctly');

const entrypoint = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
assert.match(
  entrypoint,
  /\[youtube-subscribe\] interaction failed/,
  'the gateway must log and contain unexpected subscription handler failures',
);

console.log('✅ /구독 acknowledges immediately and supports user-scoped DM subscriptions');
