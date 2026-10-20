import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { modelNames } from '../transcription/models.js';

export const command = new SlashCommandBuilder()
  .setName('transcript')
  .setDescription('Record and transcribe your voice channel locally')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((cmd) =>
    cmd.setName('start').setDescription('Start recording your current voice channel'),
  )
  .addSubcommand((cmd) =>
    cmd.setName('stop').setDescription('Stop recording your current voice channel'),
  )
  .addSubcommand((cmd) => cmd.setName('status').setDescription('View the current recording status'))
  .addSubcommandGroup((group) =>
    group
      .setName('alias')
      .setDescription('Persistent transcript names')
      .addSubcommand((cmd) =>
        cmd
          .setName('set')
          .setDescription('Set a member’s transcript name')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Member in your voice channel').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Transcript name')
              .setMaxLength(80)
              .setRequired(true),
          ),
      )
      .addSubcommand((cmd) =>
        cmd
          .setName('clear')
          .setDescription('Clear a member’s transcript alias')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Member in your voice channel').setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('model')
      .setDescription('Server transcription model')
      .addSubcommand((cmd) => cmd.setName('show').setDescription('Show the saved model'))
      .addSubcommand((cmd) =>
        cmd
          .setName('set')
          .setDescription('Set the model for future recordings (Manage Server)')
          .addStringOption((opt) =>
            opt
              .setName('model')
              .setDescription('An installed local model')
              .setRequired(true)
              .addChoices(...modelNames.map((name) => ({ name, value: name }))),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('language')
      .setDescription('Server transcription language')
      .addSubcommand((cmd) => cmd.setName('show').setDescription('Show the saved language'))
      .addSubcommand((cmd) =>
        cmd
          .setName('set')
          .setDescription('Set a language for future recordings (Manage Server)')
          .addStringOption((opt) =>
            opt
              .setName('language')
              .setDescription('Language code, or auto; configured in config/bot.json')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      ),
  );
