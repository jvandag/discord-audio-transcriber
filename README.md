# Discord audio transcriber

A TypeScript Discord bot that receives each person's voice separately, transcribes speech locally with whisper.cpp, and posts a timestamped text attachment in the voice channel's chat. No paid transcription service or API key is required. English is the default.

## Quick start

Requirements: Linux/macOS, Git, CMake, a C++ compiler, and Node.js 24.17 or newer in the Node 24 release line. Native Opus and FFmpeg are installed by npm. The local Whisper build is configured for CPU use.

```bash
nvm install
nvm use
npm ci
npm run setup:whisper
npm run model:download -- base.en
cp .env.example .env
```

On the current machine, Node 24, whisper.cpp, the English model, and npm dependencies have already been installed inside the repository. Use the local Node without changing your shell's global default:

```bash
export PATH="$PWD/.runtime/node_modules/.bin:$PATH"
```

Fill in `.env` locally with `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, and optionally `DISCORD_GUILD_ID` for immediate command registration in one development server. Obtain these from your application in the [Discord Developer Portal](https://discord.com/developers/applications). Do not commit the token.

Install the application into your server with the `bot` and `applications.commands` scopes. Grant View Channel, Connect, Send Messages, Embed Links, and Attach Files in the voice channel being recorded. Administrator, Message Content, and Server Members privileged intents are not required.

```bash
npm run doctor
npm run register
npm run build
npm start
```

`npm run register` upserts `/transcript` without deleting unrelated application commands. With no guild ID, it registers globally; Discord may take time to propagate global commands. Use `npm run dev` during development. Run only one bot process against a given data directory.

## Recording a call

Optional AI weekly reports support **OpenAI or Gemini**, fetching the latest format
from one Google Doc on every generation and appending to a separate weekly-log Doc.
Put report API keys, Google credential JSON, document URLs, and provider/model/server
settings in the private `.env` file. See [report setup and recovery](docs/reports.md).
The bot fills the live template's placeholders and preserves its member sections,
nested bullets, styling and linked names. Missing members' Last Week entries begin
with "Not present for meeting." Technical transcript metadata is removed before
any AI request is built.
Reporting is disabled by default and does not require changing your Whisper model.

Join a normal server voice channel, then run `/transcript start`. The bot joins without deafening itself and posts a recording embed in **that voice channel's own chat**, even when the slash command was invoked elsewhere.

The control message provides:

- **Status:** privately shows duration, state, captured speaker count, selected model/language, and pending/processed/failed chunks.
- **Stop Recording:** available to any human currently in the recorded channel. `/transcript stop` does the same thing.
- **Transcript alias dropdown:** shows the first 25 current human members, sorted by server display name and user ID. Selecting a person opens a form to set or clear their name. The existing message updates when people join or leave. Use slash commands for current members beyond the dropdown limit.

The bot stops after **30 continuous seconds without any humans**. Other bots do not prevent stopping; a silent human does. Returning within 30 seconds cancels the countdown. Manual stop cuts off capture immediately, disconnects, and lets queued transcription finish. The final `.txt` file is posted in the recorded channel's chat. Controls show finalization progress while work remains.

One session can be recorded per server. Each speaker gets an independent Opus decoder and audio timeline, so simultaneous speakers remain separate. Twenty or more distinct participants are supported; three simultaneous speakers is the expected workload, not a hard capture limit. All sessions share one local transcription worker so models do not multiply with participant count.

Example output:

```text
Session started: 2026-10-20T19:30:00.000Z
Voice channel: General
Model: base.en
Language: en
Timestamps: approximate elapsed time since capture started

[00:00:03.200–00:00:06.850] Insert Name: Let's review the deployment.
[00:00:04.100–00:00:05.900] Alex: I have the notes ready.
```

Timestamps are based on local audio reception and Whisper's segment estimates, rather than the time recognition completes. Overlap is preserved. A participant legend contains Discord IDs, and duplicate aliases are disambiguated. Recording interruptions and failed audio chunks are identified in the output.

## Aliases and repository permission policy

```text
/transcript alias set user:@member name:Insert Name
/transcript alias clear user:@member
```

Aliases persist in SQLite by **server ID and Discord user ID**. They survive restarts and changes to Discord nicknames. Changes during recording apply throughout that session's final transcript, including speech from someone who subsequently leaves. Delivered transcripts remain unchanged.

Configure permissions in [config/bot.json](config/bot.json), then restart the bot:

| `aliasPermissions` | Who can change aliases                                                         |
| ------------------ | ------------------------------------------------------------------------------ |
| `anyone` (default) | Anyone sharing the target member's current voice channel.                      |
| `self`             | Members may change their own aliases; Manage Server members may change others. |
| `manage-guild`     | Only members with Manage Server permission.                                    |

Editors and targets must be humans in the same voice channel. The modal also requires that its recording remain active. Stale forms and controls are revalidated on submission.

## Models and languages

Model and language choices persist **per server** and apply to the next recording. An active session keeps its original configuration. Manage Server permission is required to change these settings.

```bash
# Install only models you plan to use. Downloads are checksum verified.
npm run model:download -- small.en
npm run model:download -- base
```

```text
/transcript model show
/transcript model set model:small.en
/transcript language show
/transcript language set language:en
```

Available models: `tiny`, `base`, `small`, `medium`, their `.en` variants, `large-v3`, `large-v3-turbo`, and quantized `large-v3-q5_0` / `large-v3-turbo-q5_0`. The downloader also accepts `basic` as `base` and `large` as `large-v3`. Missing model files are rejected with an installation instruction. There is no silent fallback to a smaller model.

The default is `base.en` with English selected. To enable additional languages, edit the allowlist in `config/bot.json` and restart:

```json
{
  "allowedLanguages": ["en", "es", "fr", "ja", "auto"]
}
```

Keep the other configuration fields when editing. Choose a multilingual model before another language or auto-detection:

```text
/transcript model set model:base
/transcript language set language:auto
```

`auto` detects language separately for each speech chunk; it is already enabled in the shipped allowlist. `.en` models intentionally reject `auto` and non-English languages. Transcription preserves the spoken language rather than translating into English. Short fragments can be difficult to detect reliably; choose an explicit language when you know it.

`defaultModel` and `defaultLanguage` in the repository config are defaults for servers without saved settings. Changing them does not overwrite existing server settings; use the slash commands to change a server's saved values.

## Local resources and recovery

The configuration defaults to four Whisper CPU threads, 20-second maximum chunks, and 800 ms of inactivity to end a speech chunk. Model execution runs in child processes outside the Discord event loop. Audio jobs are stored on disk and in SQLite before transcription, with two attempts per job. The pending audio budget defaults to 2 GiB; reaching it stops capture with a partial-result explanation.

On the current i7-8700, the same upstream 11-second JFK sample was measured with one worker and four Whisper CPU threads. The elapsed time includes the bot's local raw-audio-to-WAV conversion and Whisper recognition; it does not include Discord reception or model download time.

| Model       | Installed size | Processing time | Approximate recognition speed |
| ----------- | -------------: | --------------: | ----------------------------: |
| `base.en`   |        142 MiB |          1.38 s |                8.0× real time |
| `medium.en` |        1.5 GiB |         13.28 s |               0.83× real time |
| `large-v3`  |        2.9 GiB |         24.77 s |               0.44× real time |

These are small-sample CPU measurements, not throughput guarantees for calls. `medium.en` and `large-v3` will build a transcription backlog during continuous recording on this machine; the control message exposes that backlog and processing continues after recording stops. `base.en` remains the practical default for responsive local use.

- `data/bot.sqlite`: settings, aliases, session state, job metadata, and recognized segments. Keep this database to preserve names and settings.
- `data/sessions/<id>/`: pending/failed raw audio, temporary conversion files, and the rendered transcript.
- `models/`: downloaded model weights.
- `vendor/whisper.cpp/`: pinned native source/build, currently v1.8.7.

Processed raw audio is deleted after its transcript segments are committed. Old failed audio and completed output files expire after `retentionHours` (24 by default), provided their session has no pending jobs. **An undelivered transcript is retained for recovery**, and recognized text/session metadata remain in SQLite. Back up or remove these deliberately according to your preferred retention policy.

Restarting marks abandoned recordings as interrupted, recovers persisted transcription jobs, and attempts to deliver captured results. It never automatically resumes recording. Failed transcript uploads are retried periodically; multi-part retries may repeat parts already uploaded before a failure. If the main bot is stopped, `npm run retry-delivery` can retry saved results manually using the same credentials.

FFmpeg can be overridden with `FFMPEG_PATH`; the native executable can be overridden with `WHISPER_CLI_PATH`. Use `BOT_CONFIG_PATH` for another repository configuration. Run from the repository root so relative paths resolve correctly. Stop with Ctrl+C or SIGTERM to flush current chunks and preserve pending jobs.

## Development and validation

```bash
npm run check          # TypeScript, lint, tests, build, and formatting
npm run smoke:whisper  # Actual native transcription of the upstream public sample
npm run smoke:whisper -- small.en
```

CI does not require credentials or large models. Tests exercise native speaker decoding, overlapping timelines, persistence, job retries, lifecycle races, attachment splitting, and menu sizes from 0 through 26+ members. See [live-test.md](docs/live-test.md) for the live Discord acceptance procedure. A real test call requires your bot credentials and human speakers.

Architecture:

```text
src/
  audio/           # Per-speaker Opus decoding, chunk timing, durable audio writes
  config/          # Validated repository configuration and environment
  discord/         # Commands, interactions, control views, Discord gateway
  sessions/        # Session lifecycle, membership timer, permissions, gateway ports
  storage/         # SQLite schema and transactional persistence
  transcription/   # Model registry, Whisper process adapter, bounded job queue
  transcripts/     # Speaker naming, text formatting, UTF-8 attachment splitting
  shared/          # Domain types, logging, process runner
scripts/           # Setup, model downloads, diagnostics, command registration
tests/             # Offline unit and integration tests
```

Discord voice reception is supported by [@discordjs/voice](https://discord.js.org/docs/packages/voice/0.19.2) but remains undocumented by Discord and may change. Dependencies include DAVE encryption support. Local recognition uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp); no speech is sent to an external transcription provider. Audio still travels through Discord, and the finished transcript is uploaded to Discord as requested.

All code and dependencies are free to use under their respective licenses. The application is MIT licensed; native FFmpeg/Opus/Whisper dependencies retain their upstream licenses.
