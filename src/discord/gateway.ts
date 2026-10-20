import { ChannelType, PermissionFlagsBits, type Client, type VoiceChannel } from 'discord.js';
import { entersState, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import type { BotConfig } from '../config/index.js';
import type { Store } from '../storage/store.js';
import type { JobCounts, Session } from '../shared/types.js';
import type { RecordingGateway } from '../sessions/ports.js';
import { AudioCapture } from '../audio/capture.js';
import { splitTranscript } from '../transcripts/render.js';
import { controlView } from './views.js';

export class DiscordGateway implements RecordingGateway {
  constructor(
    private client: Client,
    private config: BotConfig,
    private store: Store,
  ) {}
  private async channel(id: string): Promise<VoiceChannel> {
    const channel = await this.client.channels.fetch(id);
    if (!channel || channel.type !== ChannelType.GuildVoice)
      throw new Error('Use a regular server voice channel.');
    return channel;
  }
  async inspect(channelId: string) {
    const channel = await this.channel(channelId);
    const me = await channel.guild.members.fetchMe();
    const permissions = channel.permissionsFor(me);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ])
    )
      throw new Error(
        'I need View Channel, Connect, Send Messages, Embed Links, and Attach Files in the voice channel.',
      );
    if (channel.full && !permissions.has(PermissionFlagsBits.MoveMembers))
      throw new Error('The voice channel is full.');
    return { id: channel.id, guildId: channel.guild.id, name: channel.name };
  }
  members(channelId: string) {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return [];
    return [...channel.members.values()]
      .filter((member) => !member.user.bot)
      .map((member) => ({
        userId: member.id,
        displayName: member.displayName,
        username: member.user.username,
      }));
  }
  async capture(
    session: Session,
    queued: () => void,
    failure: (error: Error) => void,
    warning: (message: string) => void,
  ) {
    const channel = await this.channel(session.channelId);
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    // Install error handling before waiting for Ready so EventEmitter errors never escape.
    connection.on('error', failure);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (error) {
      connection.destroy();
      throw error;
    }
    let stopping = false;
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (stopping) return;
      warning(
        `Voice connection interrupted near ${Math.round((Date.now() - session.startedAt) / 1000)} seconds; some speech may be missing.`,
      );
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ])
        .then(() => entersState(connection, VoiceConnectionStatus.Ready, 15_000))
        .catch(() => {
          if (!stopping) failure(new Error('Voice connection lost.'));
        });
    });
    const capture = new AudioCapture(
      connection,
      session.id,
      this.config,
      this.store,
      queued,
      failure,
    );
    return {
      update: (members: ReturnType<DiscordGateway['members']>) => capture.update(members),
      stop: async () => {
        stopping = true;
        try {
          await capture.stop();
        } finally {
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        }
      },
    };
  }
  async sendControl(session: Session) {
    const channel = await this.channel(session.channelId);
    return (
      await channel.send(
        controlView(
          session,
          this.members(session.channelId),
          this.store.counts(session.id),
          0,
          (id) => this.store.alias(session.guildId, id),
        ),
      )
    ).id;
  }
  async updateControl(session: Session, counts: JobCounts, speakers: number) {
    if (!session.messageId) return;
    const channel = await this.channel(session.channelId);
    await channel.messages.edit(
      session.messageId,
      controlView(session, this.members(session.channelId), counts, speakers, (id) =>
        this.store.alias(session.guildId, id),
      ),
    );
  }
  async deliver(session: Session, transcript: string) {
    const channel = await this.channel(session.channelId);
    // Conservative limit works across guild boost tiers; split larger transcripts.
    const limit = 8 * 1024 * 1024 - 1024;
    const files = splitTranscript(transcript, limit);
    for (let i = 0; i < files.length; i++) {
      await channel.send({
        content: `Transcript ${session.id}${files.length > 1 ? ` — part ${i + 1}/${files.length}` : ''}`,
        files: [
          {
            attachment: files[i]!,
            name: `transcript-${session.id}${files.length > 1 ? `-${i + 1}` : ''}.txt`,
          },
        ],
        allowedMentions: { parse: [] },
      });
    }
  }
}
