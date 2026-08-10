import http from 'node:http';
import type { Client } from 'discord.js';
import { config } from './config.js';
import { handleDiscordInteractions } from './discordInteractions.js';
import {
  getCommandRegistrationStatus,
  registerMuelCommands,
} from './discordCommandRegistry.js';
import { getHubChannelStatus } from './hubChannels.js';
import {
  getArchiveOpenApiDocument,
  handleArchivePersonalRequest,
} from './archivist/personalAccess.js';
import { requestYouTubeMonitorSync } from './youtubeMonitor.js';
import { handleYouTubeWebSubRequest } from './youtubeWebSub.js';

type RuntimeStatus = {
  ok: boolean;
  degradedReasons: string[];
  youtubeMonitor: unknown;
  jobWorker: unknown;
  archivist: unknown;
  commands: unknown;
  supabaseRestriction: unknown;
};

type ConnectionStatus = {
  readyAt: string | null;
  loginError: string | null;
};

type RuntimeHttpServerDependencies = {
  client: Client;
  gomdoriClient: Client | null;
  getRuntimeStatus: () => RuntimeStatus;
  getMuelConnectionStatus: () => ConnectionStatus;
  getGomdoriConnectionStatus: () => ConnectionStatus;
};

const writeJson = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};

export const createRuntimeHttpServer = (
  dependencies: RuntimeHttpServerDependencies,
): http.Server => {
  const {
    client,
    gomdoriClient,
    getRuntimeStatus,
    getMuelConnectionStatus,
    getGomdoriConnectionStatus,
  } = dependencies;

  return http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('OK');
      return;
    }

    if (request.url === '/ready') {
      const runtime = getRuntimeStatus();
      writeJson(response, runtime.ok ? 200 : 503, runtime);
      return;
    }

    if (request.url?.startsWith('/youtube/websub')) {
      void handleYouTubeWebSubRequest(request, response, () => {
        if (client.isReady()) requestYouTubeMonitorSync(client, 'websub');
      });
      return;
    }

    if (request.url === '/discord/interactions' && request.method === 'POST') {
      void handleDiscordInteractions(request, response);
      return;
    }

    if (request.url === '/archive/openapi.json' && request.method === 'GET') {
      writeJson(response, 200, getArchiveOpenApiDocument(request), {
        'cache-control': 'public, max-age=300',
      });
      return;
    }

    if (request.url?.startsWith('/archive/')) {
      void handleArchivePersonalRequest(request, response);
      return;
    }

    if (request.url?.startsWith('/admin/reregister-commands') && request.method === 'POST') {
      void (async () => {
        const adminToken = process.env.MUEL_ADMIN_TOKEN?.trim();
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!adminToken || url.searchParams.get('token') !== adminToken) {
          writeJson(response, 403, { error: 'forbidden' });
          return;
        }
        if (!client.isReady()) {
          writeJson(response, 503, { error: 'client not ready' });
          return;
        }

        try {
          await registerMuelCommands(client);
          const commands = getCommandRegistrationStatus();
          writeJson(response, 200, {
            ok: true,
            lastRegisteredAt: commands.lastRegisteredAt,
            lastRegisteredCommandNames: commands.registered,
          });
        } catch (error) {
          writeJson(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return;
    }

    const runtime = getRuntimeStatus();
    const muelConnection = getMuelConnectionStatus();
    const gomdoriConnection = getGomdoriConnectionStatus();
    writeJson(response, 200, {
      ok: runtime.ok,
      degradedReasons: runtime.degradedReasons,
      muel: {
        bot: client.user?.tag ?? null,
        ...muelConnection,
        wsStatus: client.ws.status,
        ai: {
          primaryProvider: config.googleGenerativeAiApiKey
            ? 'gemini'
            : config.nvidiaApiKey
              ? 'nvidia'
              : null,
          geminiConfigured: Boolean(config.googleGenerativeAiApiKey),
          geminiModel: config.muelAiModel,
          nvidiaConfigured: Boolean(config.nvidiaApiKey),
          nvidiaModel: config.nvidiaModel,
        },
      },
      gomdori: gomdoriClient
        ? {
            bot: gomdoriClient.user?.tag ?? null,
            ...gomdoriConnection,
            wsStatus: gomdoriClient.ws.status,
          }
        : null,
      uptimeSeconds: Math.floor(process.uptime()),
      youtubeMonitor: runtime.youtubeMonitor,
      jobWorker: runtime.jobWorker,
      archivist: runtime.archivist,
      supabaseRestriction: runtime.supabaseRestriction,
      runtime: {
        enableJobWorker: config.enableJobWorker,
        enableYoutubeMonitor: config.enableYoutubeMonitor,
        mentionReplyTimeoutMs: config.mentionReplyTimeoutMs,
        enableHttpInteractions: config.enableHttpInteractions,
      },
      hub: getHubChannelStatus(),
      commands: runtime.commands,
    });
  });
};

export const startRuntimeHttpServer = (
  dependencies: RuntimeHttpServerDependencies,
): http.Server => {
  const server = createRuntimeHttpServer(dependencies);
  server.listen(config.port, () => {
    console.log(`[http] listening on ${config.port}`);
  });
  return server;
};
