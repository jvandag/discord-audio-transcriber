import {
  ActionRowBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type GuildMember,
  type Interaction,
} from 'discord.js';
import type { BotConfig } from '../config/index.js';
import type { Store } from '../storage/store.js';
import type { SessionManager } from '../sessions/manager.js';
import { canEditAlias, cleanAlias } from '../sessions/permissions.js';
import { installedModel, normalizeModel, validateLanguage } from '../transcription/models.js';
import { logger } from '../shared/logger.js';

export function installInteractions(
  client: Client,
  config: BotConfig,
  store: Store,
  manager: SessionManager,
) {
  const editAlias = (editor: GuildMember, targetId: string, name: string) => {
    const channel = editor.voice.channel;
    if (
      !channel ||
      channel.type !== ChannelType.GuildVoice ||
      !channel.members.has(targetId) ||
      channel.members.get(targetId)?.user.bot
    )
      throw new Error(
        'You and the selected human member must currently be in the same voice channel.',
      );
    if (
      !canEditAlias(
        config.aliasPermissions,
        editor.id,
        targetId,
        editor.permissions.has(PermissionFlagsBits.ManageGuild),
      )
    )
      throw new Error('The alias permission policy in config/bot.json does not allow this change.');
    store.setAlias(editor.guild.id, targetId, cleanAlias(name), editor.id);
    const session = manager.current(editor.guild.id);
    if (session) manager.refresh(session.id);
  };
  client.on('interactionCreate', (interaction: Interaction) => {
    void (async () => {
      if (!interaction.inGuild()) return;
      if (interaction.isAutocomplete()) {
        if (interaction.commandName !== 'transcript') return;
        const query = interaction.options.getFocused().toLowerCase();
        await interaction.respond(
          config.allowedLanguages
            .filter((code) => code.includes(query))
            .slice(0, 25)
            .map((code) => ({
              name: code === 'auto' ? 'auto — detect each speech chunk' : code,
              value: code,
            })),
        );
        return;
      }
      if (!(
        interaction.isChatInputCommand() ||
        interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isModalSubmit()
      ))
        return;
      if (interaction.isChatInputCommand() && interaction.commandName !== 'transcript') return;
      if (!interaction.isChatInputCommand() && !interaction.customId.startsWith('tr:')) return;
      // Open the modal immediately; don't spend its response deadline waiting on an API fetch.
      if (interaction.isStringSelectMenu()) {
        if (!interaction.inCachedGuild()) throw new Error('Server state is loading; try again.');
        const [, action, id] = interaction.customId.split(':');
        if (action !== 'alias' || !id) throw new Error('Unknown control.');
        const session = store.session(id);
        const target = interaction.values[0];
        if (
          session.guildId !== interaction.guildId ||
          session.channelId !== interaction.member.voice.channelId ||
          session.state !== 'recording' ||
          !target ||
          !interaction.member.voice.channel?.members.has(target) ||
          interaction.member.voice.channel.members.get(target)?.user.bot
        )
          throw new Error('This recording or selected member is no longer in your channel.');
        if (
          !canEditAlias(
            config.aliasPermissions,
            interaction.user.id,
            target,
            interaction.member.permissions.has(PermissionFlagsBits.ManageGuild),
          )
        )
          throw new Error(
            'You cannot edit this member’s alias under the repository permission policy.',
          );
        const input = new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Transcript name (leave blank to clear)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(false)
          .setValue(store.alias(interaction.guildId, target) ?? '');
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`tr:name:${id}:${target}`)
            .setTitle('Transcript alias')
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
        );
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild ?? (await client.guilds.fetch(interaction.guildId));
      const editor = await guild.members.fetch(interaction.user.id);
      if (interaction.isModalSubmit()) {
        const [, action, id, target] = interaction.customId.split(':');
        if (action !== 'name' || !id || !target) throw new Error('Unknown alias form.');
        const session = store.session(id);
        if (
          session.guildId !== guild.id ||
          session.channelId !== editor.voice.channelId ||
          session.state !== 'recording'
        )
          throw new Error('This recording has ended or you have left its channel.');
        editAlias(editor, target, interaction.fields.getTextInputValue('name'));
        await interaction.editReply('Transcript alias saved.');
        return;
      }
      if (interaction.isButton()) {
        const [, action, id] = interaction.customId.split(':');
        if (!id) throw new Error('Unknown recording.');
        const session = store.session(id);
        if (session.guildId !== guild.id)
          throw new Error('This control belongs to another server.');
        if (action === 'stop') {
          if (editor.voice.channelId !== session.channelId)
            throw new Error('Join the recorded voice channel to stop recording.');
          await manager.stop(id, `Stopped by Discord user ${editor.id}.`);
          await interaction.editReply(
            'Recording stopped. The transcript will be posted here when processing finishes.',
          );
        } else if (action === 'status') {
          const channel = await guild.channels.fetch(session.channelId);
          if (!channel?.permissionsFor(editor)?.has(PermissionFlagsBits.ViewChannel))
            throw new Error('You cannot view this voice channel.');
          const counts = store.counts(id);
          await interaction.editReply(
            `State: ${session.state}\nDuration: ${Math.round(((session.endedAt ?? Date.now()) - session.startedAt) / 1000)} seconds\nModel: ${session.model} · Language: ${session.language}\nCaptured speakers: ${store.participants(id).length}\nChunks: ${counts.done} processed, ${counts.pending} pending, ${counts.failed} failed.`,
          );
        } else throw new Error('Unknown recording control.');
        return;
      }
      const group = interaction.options.getSubcommandGroup();
      const sub = interaction.options.getSubcommand();
      if (group === 'alias') {
        editAlias(
          editor,
          interaction.options.getUser('user', true).id,
          sub === 'clear' ? '' : interaction.options.getString('name', true),
        );
        await interaction.editReply('Transcript alias saved.');
        return;
      }
      if (group === 'model' || group === 'language') {
        const settings = store.settings(guild.id);
        if (sub === 'set') {
          if (!editor.permissions.has(PermissionFlagsBits.ManageGuild))
            throw new Error(
              'Manage Server permission is required to change transcription settings.',
            );
          if (group === 'model') {
            const model = normalizeModel(interaction.options.getString('model', true));
            validateLanguage(model, settings.language, config.allowedLanguages);
            await installedModel(config.modelsDirectory, model);
            settings.model = model;
          } else {
            const language = interaction.options.getString('language', true).trim().toLowerCase();
            validateLanguage(settings.model, language, config.allowedLanguages);
            settings.language = language;
          }
          store.saveSettings(guild.id, settings);
        }
        const active = manager.current(guild.id);
        await interaction.editReply(
          `Saved model: ${settings.model}\nSaved language: ${settings.language}${active ? `\nActive recording: ${active.model} / ${active.language}. Changes apply to the next recording.` : ''}`,
        );
        return;
      }
      if (sub === 'start') {
        if (!editor.voice.channelId) throw new Error('Join a voice channel first.');
        const session = await manager.start(editor.voice.channelId, guild.id);
        // The requester can leave or move while the connection is establishing.
        manager.membershipChanged(guild.id);
        await interaction.editReply(
          `Recording started in <#${session.channelId}>. Controls and the final transcript will appear in its chat.`,
        );
      } else if (sub === 'stop') {
        const session = manager.current(guild.id);
        if (!session || editor.voice.channelId !== session.channelId)
          throw new Error('Join this server’s recorded voice channel to stop recording.');
        await manager.stop(session.id, `Stopped by Discord user ${editor.id}.`);
        await interaction.editReply(
          'Recording stopped. The transcript will appear in the voice channel chat when processing finishes.',
        );
      } else {
        const session = manager.current(guild.id);
        if (!session) {
          await interaction.editReply('No active recording in this server.');
          return;
        }
        const channel = await guild.channels.fetch(session.channelId);
        if (!channel?.permissionsFor(editor)?.has(PermissionFlagsBits.ViewChannel))
          throw new Error('You cannot view this voice channel.');
        const counts = store.counts(session.id);
        await interaction.editReply(
          `${session.state} in <#${session.channelId}> · ${session.model}/${session.language} · ${counts.done} processed, ${counts.pending} pending, ${counts.failed} failed.`,
        );
      }
    })().catch(async (error) => {
      logger.warn({ err: error, interactionType: interaction.type }, 'Interaction failed');
      if (!interaction.isRepliable()) return;
      const content = error instanceof Error ? error.message : 'Something went wrong.';
      try {
        if (interaction.deferred || interaction.replied)
          await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
      } catch (replyError) {
        logger.warn({ err: replyError }, 'Could not respond to interaction');
      }
    });
  });
  client.on('voiceStateUpdate', (oldState, newState) => {
    const session = manager.current(newState.guild.id);
    if (!session) return;
    if (
      newState.id === client.user?.id &&
      oldState.channelId === session.channelId &&
      newState.channelId !== session.channelId &&
      session.state === 'recording'
    ) {
      void manager
        .stop(session.id, 'Bot was removed from or moved out of the recorded channel.')
        .catch((error) => logger.error({ err: error }, 'Could not stop moved bot'));
    } else manager.membershipChanged(newState.guild.id);
  });
  client.on('guildMemberUpdate', (_oldMember, member) =>
    manager.membershipChanged(member.guild.id),
  );
  client.on('channelDelete', (channel) => {
    if (!('guild' in channel)) return;
    const session = manager.current(channel.guild.id);
    if (session?.channelId === channel.id && session.state === 'recording')
      void manager
        .stop(session.id, 'Recorded channel was deleted.')
        .catch((error) => logger.error({ err: error }, 'Could not stop deleted channel'));
  });
}
