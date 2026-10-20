import type { JobCounts, Member, Session } from '../shared/types.js';
export interface ChannelInfo {
  id: string;
  guildId: string;
  name: string;
}
export interface CaptureHandle {
  update(members: Member[]): void;
  stop(): Promise<void>;
}
export interface RecordingGateway {
  inspect(channelId: string): Promise<ChannelInfo>;
  members(channelId: string): Member[];
  capture(
    session: Session,
    queued: () => void,
    failure: (error: Error) => void,
    warning: (message: string) => void,
  ): Promise<CaptureHandle>;
  sendControl(session: Session): Promise<string>;
  updateControl(session: Session, counts: JobCounts, speakers: number): Promise<void>;
  deliver(session: Session, transcript: string): Promise<void>;
}
