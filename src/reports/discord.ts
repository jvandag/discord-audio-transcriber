import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
} from 'discord.js';
import type { ReportsConfig } from './config.js';
import { configuredDestination } from './config.js';
import type { ReportJob, ReportNotifier } from './types.js';
import type { Store } from '../storage/store.js';

export function canManageReports(member: GuildMember, config: ReportsConfig) {
  return (
    !member.user.bot &&
    (member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      config.allowedRoleIds.some((id) => member.roles.cache.has(id)))
  );
}
export function reportStatus(job: ReportJob, includeDocumentUrl = true): string {
  return [
    `Report: ${job.state} | ${job.options.provider} / ${job.options.model}`,
    `Requested by: <@${job.requestedBy}>`,
    ...(includeDocumentUrl && job.documentUrl ? [`Weekly log: ${job.documentUrl}`] : []),
    ...(job.state === 'needs_review'
      ? [
          job.reviewIssues.length
            ? `${job.reviewIssues.length} factuality issue(s) require review. Preview includes the issues and evidence. Discard and regenerate after addressing them.`
            : 'Preview the draft, then approve it for the weekly log.',
        ]
      : []),
    ...(job.error ? [job.error] : []),
    ...(job.nextAttemptAt > Date.now() ? ['A bounded retry is scheduled.'] : []),
  ].join('\n');
}
export function reportControls(sessionId: string, options: ReportsConfig, job?: ReportJob) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const button = (action: string, label: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder()
      .setCustomId(`tr:${action}:${sessionId}${job ? `:${job.id}` : ''}`)
      .setLabel(label)
      .setStyle(style);
  if (!job) row.addComponents(button('report', 'Generate report', ButtonStyle.Primary));
  else if (job.state === 'published' && job.documentUrl)
    row.addComponents(button('report-open', 'View weekly report log', ButtonStyle.Primary));
  else if (job.state === 'needs_review') {
    row.addComponents(button('report-preview', 'Preview report'));
    if (!job.reviewIssues.length)
      row.addComponents(button('report-approve', 'Append reviewed report', ButtonStyle.Success));
    row.addComponents(button('report-discard', 'Discard draft', ButtonStyle.Danger));
  } else if (job.state === 'failed')
    row.addComponents(button('report-retry', 'Retry report', ButtonStyle.Primary));
  else if (job.state === 'discarded')
    row.addComponents(
      button('report-regenerate', 'Regenerate from latest template', ButtonStyle.Primary),
    );
  else
    row.addComponents(
      button(
        'report',
        job.state === 'publishing' || job.state === 'ready'
          ? 'Appending report…'
          : 'Generating report…',
      ).setDisabled(true),
    );
  return { components: options.enabled ? [row] : [], allowedMentions: { parse: [] as never[] } };
}
export class DiscordReportNotifier implements ReportNotifier {
  constructor(
    private client: Client,
    private store: Store,
  ) {}
  async update(job: ReportJob) {
    const channel = await this.client.channels.fetch(job.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.guild.id !== job.guildId)
      throw new Error('Report channel is unavailable.');
    const view = reportControls(job.sessionId, job.options, job);
    const transcriptId = this.store.lastTranscriptMessage(job.sessionId);
    if (transcriptId) {
      try {
        await channel.messages.edit(transcriptId, view);
      } catch (error) {
        if ((error as { code?: number }).code !== 10008) throw error;
      }
    }
    const payload = { content: reportStatus(job, false), ...view };
    if (job.notificationMessageId) {
      try {
        await channel.messages.edit(job.notificationMessageId, payload);
        return;
      } catch (error) {
        if ((error as { code?: number }).code !== 10008) throw error;
      }
    }
    job.notificationMessageId = (await channel.send(payload)).id;
  }
}
export function reportDisclosure(config: ReportsConfig, guildId: string) {
  configuredDestination(config, guildId);
  return `Optional report: clicking Generate report sends transcript text to ${config.provider}, fetches the latest private report format, and appends the result to the configured weekly log.`;
}
