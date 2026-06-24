import {
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";
import { renderDiscordMessage } from "./rendering/discordRenderer.js";
import {
  type CodexAbility,
  type CodexEntry,
  type CodexFaction,
  FACTION_LABEL,
  codexByFaction,
  codexById,
} from "./gomdoriCodex.js";

/**
 * /도감 — Gomdori 직업 도감. 진영(천사/악마/조력자/중립)을 고르면 그 진영 직업이
 * 메모처럼 목록 카드로 뜨고, 드롭다운에서 직업을 고르면 상세(정본 능력 + v1/v2 스펙)가
 * 펼쳐진다. 전부 기존 렌더 단위(info-card + selectMenu)를 재활용하며, 도감 데이터는
 * 엔진과 분리된 gomdoriCodex.ts 에 있다.
 *
 * Discord 컴포넌트는 메시지당 5행 한도라 10직업(천사)에 버튼 10개는 불가 → 메모와
 * 동일하게 selectMenu(1행, 최대 25옵션)로 '자세히 보기'를 제공한다.
 */

export const CODEX_COMMAND_NAME = "도감";
const CODEX_DETAIL_SELECT_PREFIX = "codex:detail:";
const EPHEMERAL = MessageFlags.Ephemeral;

// Codex cards are Muel's own first-party game UI → Muel brand tone (green),
// matching /메모 and the rest of Muel's info/help surfaces.
const FACTION_TONE = "muel" as const;

export const buildCodexSlashCommand = () =>
  new SlashCommandBuilder()
    .setName(CODEX_COMMAND_NAME)
    .setDescription("Gomdori 직업 도감 — 진영별 직업과 능력을 살펴봅니다.")
    .addStringOption((opt) =>
      opt
        .setName("진영")
        .setDescription("천사 / 악마 / 조력자 / 중립")
        .setRequired(true)
        .addChoices(
          { name: "천사", value: "angel" },
          { name: "악마", value: "demon" },
          { name: "조력자", value: "helper" },
          { name: "중립", value: "neutral" },
        ),
    );

function factionListMessage(faction: CodexFaction) {
  const entries = codexByFaction(faction);
  const label = FACTION_LABEL[faction];

  const fields = entries.map((e) => ({
    name: `${e.name} · ${e.title}`,
    value: e.summary,
  }));

  return renderDiscordMessage([
    {
      type: "info-card",
      tone: FACTION_TONE,
      title: `${label} 도감`,
      body: `${label} 진영의 직업 ${entries.length}종. 아래에서 직업을 고르면 정본 능력과 구현 스펙을 볼 수 있어.`,
      fields,
      footer: "Gomdori 도감 · 자세히 볼 직업을 선택하세요",
      selectMenu: {
        customId: `${CODEX_DETAIL_SELECT_PREFIX}${faction}`,
        placeholder: "자세히 볼 직업을 선택하세요",
        options: entries.map((e) => ({
          label: e.name,
          value: e.id,
          description: e.title.slice(0, 100),
        })),
      },
    },
  ]);
}

function detailMessage(entry: CodexEntry) {
  const label = FACTION_LABEL[entry.faction];
  // 패시브(상시·직접 사용 아님)와 능력(사용)을 위계로 나눠 표시 — 로컬 캐논 구조.
  const isPassiveKind = (k: CodexAbility["kind"]): boolean => k === "패시브" || k === "특수 패시브";
  const usableAbilities = entry.abilities.filter((a) => !isPassiveKind(a.kind));
  const passiveAbilities = entry.abilities.filter((a) => isPassiveKind(a.kind));
  const abilityFields: { name: string; value: string }[] = [];
  if (usableAbilities.length > 0) {
    abilityFields.push({ name: "【사용 능력 · 밤에 발동】", value: "직접 발동하는 능력입니다." });
    for (const a of usableAbilities) abilityFields.push({ name: `〈${a.kind}〉 ${a.name}`, value: a.text.slice(0, 1024) });
  }
  if (passiveAbilities.length > 0) {
    abilityFields.push({ name: "【패시브 · 상시】", value: "직접 사용하는 능력이 아니라 상시·조건으로 작동합니다." });
    for (const a of passiveAbilities) abilityFields.push({ name: `〈${a.kind}〉 ${a.name}`, value: a.text.slice(0, 1024) });
  }

  return renderDiscordMessage([
    {
      type: "info-card",
      tone: FACTION_TONE,
      title: `${entry.name} · ${entry.title}`,
      body: `${label}${entry.slot ? ` · ${entry.slot}` : ""}\n${entry.summary}`,
      fields: [
        ...abilityFields,
        { name: "▼ v1 현황", value: entry.v1.slice(0, 1024) },
        { name: "▼ v2 구현 스펙", value: entry.v2.slice(0, 1024) },
      ],
      footer: entry.vault ? `정본: ${entry.vault}` : "Gomdori 도감",
    },
  ]);
}

export async function handleCodexCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const faction = interaction.options.getString("진영", true) as CodexFaction;
  const rendered = factionListMessage(faction) as Record<string, unknown>;
  await interaction.reply({ ...rendered, flags: EPHEMERAL });
}

export const isCodexSelect = (customId: string): boolean =>
  customId.startsWith(CODEX_DETAIL_SELECT_PREFIX);

export async function handleCodexSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const roleId = interaction.values[0];
  const entry = roleId ? codexById(roleId) : undefined;
  if (!entry) {
    await interaction.reply({ content: "그 직업은 도감에 없어. 목록을 다시 열어줘.", flags: EPHEMERAL }).catch(() => {});
    return;
  }
  const rendered = detailMessage(entry) as Record<string, unknown>;
  await interaction.reply({ ...rendered, flags: EPHEMERAL });
}
