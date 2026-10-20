import { EventEmitter } from 'node:events';
import { ChannelType, type Client, type Interaction } from 'discord.js';
import { afterEach, expect, it, vi } from 'vitest';
import { installInteractions } from '../src/discord/interactions.js';
import { parseConfig } from '../src/config/index.js';
import { Store } from '../src/storage/store.js';
import type { SessionManager } from '../src/sessions/manager.js';
import { session } from './helpers.js';

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
function harness(policy: 'anyone' | 'self' | 'manage-guild' = 'anyone') {
  const client = new EventEmitter();
  const store = new Store(':memory:', { model: 'base.en', language: 'en' });
  stores.push(store);
  store.saveSession(session());
  const members = new Map([
    ['target', { user: { bot: false } }],
    ['editor', { user: { bot: false } }],
  ]);
  const channel = { id: 'voice-1', type: ChannelType.GuildVoice, members };
  const editor = {
    id: 'editor',
    voice: { channelId: 'voice-1' as string | null, channel },
    permissions: { has: () => false },
    guild: { id: 'guild-1' },
  };
  const guild = { id: 'guild-1', members: { fetch: vi.fn(async () => editor) } };
  const stop = vi.fn(async () => {});
  const manager = {
    stop,
    current: () => store.session('session-1'),
    refresh: vi.fn(),
  } as unknown as SessionManager;
  installInteractions(client as Client, parseConfig({ aliasPermissions: policy }), store, manager);
  const interaction = {
    guildId: 'guild-1',
    guild,
    member: editor,
    user: { id: 'editor' },
    type: 3,
    customId: 'tr:alias:session-1',
    values: ['target'],
    deferred: false,
    replied: false,
    inGuild: () => true,
    inCachedGuild: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    isRepliable: () => true,
    showModal: vi.fn(async (modal: { toJSON(): unknown }) => {
      modal.toJSON();
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async (_response: unknown) => {}),
    reply: vi.fn(async (_response: unknown) => {}),
    fields: { getTextInputValue: () => 'Insert Name' },
  };
  const emit = () => client.emit('interactionCreate', interaction as unknown as Interaction);
  return { interaction, editor, members, store, stop, emit };
}

it('opens a valid empty alias modal and persists another member’s submitted alias', async () => {
  const { interaction, store, emit } = harness();
  emit();
  await vi.waitFor(() => expect(interaction.showModal).toHaveBeenCalledOnce());
  expect(interaction.reply).not.toHaveBeenCalled();
  interaction.customId = 'tr:name:session-1:target';
  interaction.isStringSelectMenu = () => false;
  interaction.isModalSubmit = () => true;
  emit();
  await vi.waitFor(() =>
    expect(interaction.editReply).toHaveBeenCalledWith('Transcript alias saved.'),
  );
  expect(store.alias('guild-1', 'target')).toBe('Insert Name');
});
it('rejects a modal if the selected member leaves before submission', async () => {
  const { interaction, members, store, emit } = harness();
  interaction.customId = 'tr:name:session-1:target';
  interaction.isStringSelectMenu = () => false;
  interaction.isModalSubmit = () => true;
  members.delete('target');
  emit();
  await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());
  expect(store.alias('guild-1', 'target')).toBeUndefined();
  expect(interaction.editReply.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining('same voice channel'),
  });
});
it('enforces the repository alias policy on dropdown selection', async () => {
  const { interaction, emit } = harness('manage-guild');
  emit();
  await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalled());
  expect(interaction.showModal).not.toHaveBeenCalled();
});
it('only allows people in the recorded voice channel to use Stop', async () => {
  const { interaction, editor, stop, emit } = harness();
  interaction.customId = 'tr:stop:session-1';
  interaction.isStringSelectMenu = () => false;
  interaction.isButton = () => true;
  editor.voice.channelId = 'another-channel';
  emit();
  await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());
  expect(stop).not.toHaveBeenCalled();
  interaction.editReply.mockClear();
  editor.voice.channelId = 'voice-1';
  emit();
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
});
