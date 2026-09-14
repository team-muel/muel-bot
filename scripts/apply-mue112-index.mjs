import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/index.ts';
let source = readFileSync(path, 'utf8');

const replaceOnce = (oldText, newText) => {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`expected one anchor, found ${count}: ${oldText.slice(0, 80)}`);
  source = source.replace(oldText, newText);
};

replaceOnce(
  "import { buildRuntimeStatus } from './runtimeStatus.js';",
  "import { buildRuntimeStatus, collectRuntimeStatus } from './runtimeStatus.js';\nimport { onSafeDiscordEvent } from './discordEventSafety.js';",
);
replaceOnce(
  "      loginError = error instanceof Error ? error.message : String(error);\n      console.error('[discord] command registration failed', error);",
  "      console.error('[discord] command registration failed', error);",
);
replaceOnce(
  "      gomdoriLoginError = error instanceof Error ? error.message : String(error);\n        console.error('[gomdori] command registration failed', error);",
  "      console.error('[gomdori] command registration failed', error);",
);

for (const [oldText, newText] of [
  ['client.on(Events.InteractionCreate, async (interaction) => {', 'onSafeDiscordEvent(client, Events.InteractionCreate, async (interaction) => {'],
  ['client.on(Events.MessageCreate, async (message) => {', 'onSafeDiscordEvent(client, Events.MessageCreate, async (message) => {'],
  ['client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {', 'onSafeDiscordEvent(client, Events.MessageUpdate, async (oldMessage, newMessage) => {'],
  ['client.on(Events.MessageDelete, async (message) => {', 'onSafeDiscordEvent(client, Events.MessageDelete, async (message) => {'],
  ['client.on(Events.MessageReactionAdd, async (reaction, user) => {', 'onSafeDiscordEvent(client, Events.MessageReactionAdd, async (reaction, user) => {'],
  ['client.on(Events.GuildMemberAdd, async (member) => {', 'onSafeDiscordEvent(client, Events.GuildMemberAdd, async (member) => {'],
  ['client.on(Events.GuildMemberRemove, async (member) => {', 'onSafeDiscordEvent(client, Events.GuildMemberRemove, async (member) => {'],
  ['gomdoriClient.on(Events.InteractionCreate, async (interaction) => {', 'onSafeDiscordEvent(gomdoriClient, Events.InteractionCreate, async (interaction) => {'],
]) replaceOnce(oldText, newText);

replaceOnce(
  '  getRuntimeStatus: () => buildRuntimeStatus({',
  '  getRuntimeStatus: () => buildRuntimeStatus(collectRuntimeStatus({',
);
replaceOnce(
  '    gomdoriLoginError,\n  }),\n  getMuelConnectionStatus:',
  '    gomdoriLoginError,\n  })),\n  getMuelConnectionStatus:',
);

writeFileSync(path, source);
