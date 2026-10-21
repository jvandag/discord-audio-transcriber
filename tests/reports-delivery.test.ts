import { ChannelType, type Client } from 'discord.js';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/index.js';
import { DiscordGateway } from '../src/discord/gateway.js';
import { DiscordReportNotifier } from '../src/reports/discord.js';
import { reportJob, reportOptions, reportStore } from './reports-helpers.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((action) => action()));
function harness(enabled = true) {
  const store = reportStore();
  cleanup.push(() => store.close());
  const send = vi.fn(async (_payload: unknown) => ({ id: 'transcript-message' }));
  const edit = vi.fn(async (_id: string, _payload: unknown) => ({}));
  const channel = {
    type: ChannelType.GuildVoice,
    guild: { id: 'guild-1' },
    send,
    messages: { edit },
  };
  const client = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
  const options = reportOptions();
  options.enabled = enabled;
  const gateway = new DiscordGateway(client, parseConfig({ reports: options }), store);
  return { store, gateway, client, send, edit, channel };
}
it('attaches report controls without exposing private document URLs', async () => {
  const { store, gateway, send } = harness();
  await gateway.deliver(store.session('session-1'), 'Complete transcript.');
  const payload = send.mock.calls[0]![0] as {
    content: string;
    components: { toJSON(): unknown }[];
    files: { name: string }[];
  };
  expect(payload.content).toContain('gemini');
  expect(payload.content).not.toContain('docs.google.com');
  expect(JSON.stringify(payload.components.map((row) => row.toJSON()))).toContain(
    'tr:report:session-1',
  );
  expect(payload.files[0]!.name).toBe('transcript-session-1.txt');
  expect(store.lastTranscriptMessage('session-1')).toBe('transcript-message');
  await gateway.deliver(store.session('session-1'), 'Complete transcript.');
  expect(send).toHaveBeenCalledOnce();
});
it('keeps transcription delivery working with disabled or incomplete report configuration', async () => {
  const disabled = harness(false);
  await disabled.gateway.deliver(disabled.store.session('session-1'), 'Transcript.');
  expect(disabled.send.mock.calls[0]![0]).not.toHaveProperty('components');
  const enabled = harness();
  const config = parseConfig({ reports: { enabled: true } });
  const gateway = new DiscordGateway(enabled.client, config, enabled.store);
  await gateway.deliver(enabled.store.session('session-1'), 'Transcript.');
  expect(enabled.send.mock.calls[0]![0]).toMatchObject({
    content: expect.stringContaining('configuration is incomplete'),
  });
});
it('updates report controls without replacing the transcript attachment', async () => {
  const { client, store, send, edit } = harness();
  store.saveTranscriptMessage('session-1', 0, 'transcript-message');
  const job = reportJob();
  await new DiscordReportNotifier(client, store).update(job);
  expect(edit.mock.calls[0]![0]).toBe('transcript-message');
  expect(edit.mock.calls[0]![1]).not.toHaveProperty('files');
  expect(send).toHaveBeenCalledOnce();
  await new DiscordReportNotifier(client, store).update(job);
  expect(send).toHaveBeenCalledOnce();
});
it('only offers a permission-checked button and never broadcasts the published URL', async () => {
  const { client, store, send, edit } = harness();
  store.saveTranscriptMessage('session-1', 0, 'transcript-message');
  const job = reportJob();
  job.state = 'published';
  job.documentUrl = job.destination.logUrl;
  await new DiscordReportNotifier(client, store).update(job);
  for (const payload of [
    ...edit.mock.calls.map((call) => call[1]),
    ...send.mock.calls.map((call) => call[0]),
  ]) {
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('docs.google.com');
    expect(serialized).not.toContain('"url":');
    expect(serialized).toContain('report-open');
  }
});
