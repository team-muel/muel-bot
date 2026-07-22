import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { config } from '../config.js';

export const ARCHIVE_POLICY_COMMAND_NAME = '정책';

export const buildArchivePolicyCommand = (): RESTPostAPIChatInputApplicationCommandsJSONBody =>
  new SlashCommandBuilder()
    .setName(ARCHIVE_POLICY_COMMAND_NAME)
    .setDescription('이 서버의 기록 보존·마스킹·삭제 정책을 확인합니다.')
    .toJSON();

export const buildArchivePolicyEmbed = () => ({
  color: 0x5865f2,
  title: '기록 보존 정책',
  description: '이 서버는 운영자가 소유한 단일 서버 아카이브를 운용합니다.',
  fields: [
    {
      name: '무엇을 보존하나요?',
      value: '봇이 접근할 수 있는 이 길드의 모든 채널을 대상으로, 서버 개설 이후 Discord API에서 현재 조회 가능한 전체 메시지를 끝까지 백필하고 이후 메시지·수정 이력·첨부를 계속 보존합니다. DM과 다른 서버는 수집하지 않습니다. 아카이브 도입 전에 이미 삭제된 기록은 복원할 수 없으며, 도입 후 Discord에서 삭제된 메시지는 자동 삭제하지 않습니다.',
    },
    {
      name: '서버를 나가면?',
      value: '신원을 즉시 소프트 마스킹합니다. 6개월 안에 돌아오면 복원할 수 있고, 복귀하지 않으면 신원 복호화 정보를 영구 파기합니다.',
    },
    {
      name: '명시적 삭제 요청',
      value: '필요한 경우 운영자가 본문을 툼스톤 처리해 내용은 지우고 대화 구조만 남길 수 있습니다.',
    },
  ],
  ...(config.archivePolicyUrl ? { url: config.archivePolicyUrl } : {}),
  footer: {
    text: config.archivePolicyUrl
      ? '전체 정책은 제목 링크에서 확인할 수 있습니다.'
      : '전체 투명성 페이지 링크는 준비 후 이 명령에 연결됩니다.',
  },
});

export const handleArchivePolicyCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  if (!config.ownedGuildId || interaction.guildId !== config.ownedGuildId) {
    await interaction.reply({ content: '이 서버에서는 사용할 수 없는 명령이야.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ embeds: [buildArchivePolicyEmbed()], flags: MessageFlags.Ephemeral });
};

export const buildArchivePolicyHttpResponse = (guildId: string | null | undefined) => {
  if (!config.ownedGuildId || guildId !== config.ownedGuildId) {
    return { content: '이 서버에서는 사용할 수 없는 명령이야.', flags: 1 << 6 };
  }
  return { embeds: [buildArchivePolicyEmbed()], flags: 1 << 6 };
};
