import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { JobCounts, Member, Session } from '../shared/types.js';

export function menuMembers(members: Member[]): Member[] {
  return [...members]
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId))
    .slice(0, 25);
}
export function controlView(
  session: Session,
  members: Member[],
  counts: JobCounts,
  speakers: number,
  alias: (userId: string) => string | undefined,
) {
  const recording = session.state === 'recording';
  const eligible = menuMembers(members);
  const embed = new EmbedBuilder()
    .setTitle('Voice transcript')
    .setColor(recording ? 0xe74c3c : 0x3498db)
    .setDescription(
      recording
        ? 'Recording each speaker separately. Anyone in this call can stop recording.'
        : `Recording ${session.state}.`,
    )
    .addFields(
      { name: 'Started', value: `<t:${Math.floor(session.startedAt / 1000)}:R>`, inline: true },
      { name: 'Model / language', value: `${session.model} / ${session.language}`, inline: true },
      {
        name: 'Members / captured speakers',
        value: `${members.length} / ${speakers}`,
        inline: true,
      },
      {
        name: 'Audio chunks',
        value: `${counts.done} processed · ${counts.pending} pending · ${counts.failed} failed`,
      },
    );
  if (members.length > 25)
    embed.setFooter({
      text: `Showing the first 25 of ${members.length} members. Use /transcript alias for other members.`,
    });
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tr:status:${session.id}`)
      .setLabel('Status')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`tr:stop:${session.id}`)
      .setLabel('Stop Recording')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!recording),
  );
  const select = new StringSelectMenuBuilder()
    .setCustomId(`tr:alias:${session.id}`)
    .setPlaceholder('Set a transcript alias…')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(!recording || !eligible.length)
    .addOptions(
      eligible.length
        ? eligible.map((member) => ({
            label: member.displayName.slice(0, 100) || member.userId,
            value: member.userId,
            description: `${member.username} · ${alias(member.userId) ?? 'No alias'}`.slice(0, 100),
          }))
        : [{ label: 'No members in the channel', value: 'empty' }],
    );
  return {
    embeds: [embed],
    components: [buttons, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    allowedMentions: { parse: [] as never[] },
  };
}
