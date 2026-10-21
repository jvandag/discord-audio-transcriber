import { EventEmitter } from 'node:events';
import { ChannelType, type Client, type Interaction } from 'discord.js';
import { afterEach, expect, it, vi } from 'vitest';
import { installInteractions } from '../src/discord/interactions.js';
import { parseConfig } from '../src/config/index.js';
import type { ReportManager } from '../src/reports/manager.js';
import type { SessionManager } from '../src/sessions/manager.js';
import { reportControls } from '../src/reports/discord.js';
import { reportJob, reportOptions, reportStore } from './reports-helpers.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((action) => action()));
function harness() {
  const client = new EventEmitter();
  const store = reportStore();
  cleanup.push(() => store.close());
  let visible = true;
  let manage = true;
  const roles = new Map<string, boolean>();
  const editor = {
    id: 'editor',
    user: { bot: false },
    voice: { channelId: null },
    permissions: { has: () => manage },
    roles: { cache: roles },
  };
  const channel = { type: ChannelType.GuildVoice, permissionsFor: () => ({ has: () => visible }) };
  const guild = {
    id: 'guild-1',
    members: { fetch: vi.fn(async () => editor) },
    channels: { fetch: vi.fn(async () => channel) },
  };
  const reports = {
    request: vi.fn(() => reportJob()),
    retry: vi.fn(() => reportJob()),
    approve: vi.fn(() => reportJob()),
    discard: vi.fn(() => reportJob()),
    regenerate: vi.fn(() => reportJob()),
  };
  const config = parseConfig({ reports: { ...reportOptions(), allowedRoleIds: ['report-role'] } });
  installInteractions(
    client as Client,
    config,
    store,
    {} as SessionManager,
    reports as unknown as ReportManager,
  );
  const interaction = {
    guildId: 'guild-1',
    guild,
    user: { id: 'editor' },
    customId: 'tr:report:session-1',
    deferred: false,
    replied: false,
    inGuild: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async (_value: unknown) => {}),
    reply: vi.fn(),
  };
  return {
    store,
    reports,
    editor,
    interaction,
    roles,
    setVisible: (value: boolean) => {
      visible = value;
    },
    setManage: (value: boolean) => {
      manage = value;
    },
    emit: () => client.emit('interactionCreate', interaction as unknown as Interaction),
  };
}
it('allows a report editor after leaving voice and acknowledges promptly', async () => {
  const { interaction, reports, emit } = harness();
  emit();
  await vi.waitFor(() => expect(reports.request).toHaveBeenCalledWith('session-1', 'editor'));
  expect(interaction.deferReply).toHaveBeenCalledOnce();
});
it('denies cross-server controls and members who lost channel visibility', async () => {
  const { reports, interaction, setVisible, emit } = harness();
  setVisible(false);
  emit();
  await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());
  expect(reports.request).not.toHaveBeenCalled();
  interaction.editReply.mockClear();
  setVisible(true);
  interaction.guild.id = 'other';
  emit();
  await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());
  expect(reports.request).not.toHaveBeenCalled();
});
it('revalidates report roles and rejects stale draft approvals', async () => {
  const { reports, store, roles, interaction, setManage, emit } = harness();
  setManage(false);
  emit();
  await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());
  expect(reports.request).not.toHaveBeenCalled();
  roles.set('report-role', true);
  emit();
  await vi.waitFor(() => expect(reports.request).toHaveBeenCalledOnce());
  store.createReport(reportJob());
  interaction.customId = 'tr:report-approve:session-1:old-draft';
  emit();
  await vi.waitFor(() =>
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('stale') }),
    ),
  );
  expect(reports.approve).not.toHaveBeenCalled();
});
it('never offers approval for a factuality-flagged draft', () => {
  const job = reportJob();
  job.state = 'needs_review';
  job.reviewIssues = ['Unsupported deadline.'];
  const controls = JSON.stringify(
    reportControls(job.sessionId, job.options, job).components.map((row) => row.toJSON()),
  );
  expect(controls).toContain('report-preview');
  expect(controls).not.toContain('report-approve');
  expect(reportControls(job.sessionId, { ...job.options, enabled: false }).components).toEqual([]);
});
it('only reveals the published link privately to an authorized report editor', async () => {
  const { store, interaction, setManage, emit } = harness();
  const job = reportJob();
  job.state = 'published';
  job.documentUrl = job.destination.logUrl;
  store.createReport(job);
  interaction.customId = 'tr:report-open:session-1:report-id';
  setManage(false);
  emit();
  await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());
  expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain(job.documentUrl);
  interaction.editReply.mockClear();
  setManage(true);
  emit();
  await vi.waitFor(() =>
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: `Weekly report log: ${job.documentUrl}` }),
    ),
  );
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
});
