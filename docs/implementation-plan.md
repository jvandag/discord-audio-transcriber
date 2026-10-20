# Discord audio transcriber: implementation plan

Status: implemented. See the README for setup, behavior, and validation. Live Discord acceptance requires bot credentials and a test call.

## Requirements

- Use discord.js and free, local speech recognition through whisper.cpp.
- Run on the current Linux machine: Intel Core i7-8700 (6 cores / 12 threads), approximately 32 GB RAM, and Intel UHD Graphics 630.
- Support calls with 20 or more distinct participants and approximately three simultaneous speakers. Three is a workload estimate, not a limit that discards additional speakers.
- Receive each speaker's audio separately and associate it with their Discord user ID.
- Produce a UTF-8 text transcript with speech timestamps, speaker names or aliases, and recognized text.
- Persist transcript aliases and the selected Whisper model across restarts.
- Provide slash commands and a recording control message in the recorded voice channel's own chat.
- Put Status and Stop Recording buttons, plus a current-member alias dropdown, on that message.
- Update the member dropdown as people enter or leave; show at most the first 25 human members.
- Stop immediately on a valid manual request, or after the channel has contained no humans for 30 continuous seconds.
- Send the completed transcript to the recorded voice channel's chat.

## Accepted defaults

- TypeScript with strict type checking.
- English speech by default, with a repository allowlist for additional languages and auto-detection and persistent per-server language configuration.
- Aliases and model settings are scoped to the Discord server.
- Any human currently in the recorded channel can start/stop recording. Repository-configured alias permissions default to anyone changing another current participant's alias. Model and language settings require Manage Server permission.
- Alias changes during recording apply consistently throughout that session's final transcript. Previously delivered transcripts do not change.
- Begin model benchmarking with `base.en`; choose the shipped default after measurement. Support multilingual model equivalents as well.
- Remove temporary audio after successful transcription. Retain recoverable failed jobs and undelivered transcripts for a configurable, documented period, initially 24 hours.
- One recording session per server. Share a bounded transcription worker across servers on this machine.

## Technology and feasibility

Use discord.js, @discordjs/voice with its supported DAVE dependency, @discordjs/opus, an audio stream adapter such as prism-media, FFmpeg, whisper.cpp, and SQLite. Application services should depend on small interfaces rather than concrete SDK or process implementations.

The installed shell currently selects Node.js 20.19.6; FFmpeg and whisper-cli were not found on PATH. Select and pin a supported Node runtime for the chosen released Discord packages, and document project-local runtime setup. Do not change unrelated projects' runtime settings.

Audio reception is explicitly described as undocumented by Discord in the voice library documentation. The first implementation milestone must demonstrate working DAVE-compatible reception, separate speaker streams, and transcription on this machine before building the full application. Pin tested releases and retain a live voice smoke-test procedure.

Sources: [voice library](https://discord.js.org/docs/packages/voice/main), [voice dependencies](https://discordjs.guide/voice).

## User interactions

### Commands

| Command                                           | Behavior                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/transcript start`                               | Join the requester's voice channel, create the control message there, and begin capture.  |
| `/transcript stop`                                | Stop capture if the requester is currently in the recorded channel.                       |
| `/transcript status`                              | Show lifecycle state, elapsed duration, model, speaker count, pending jobs, and failures. |
| `/transcript alias set user:<member> name:<text>` | Persist an alias; also provides access to members omitted by the dropdown cap.            |
| `/transcript alias clear user:<member>`           | Remove an alias and restore display-name fallback.                                        |
| `/transcript model show`                          | Show the configured model and the active session's model, if different.                   |
| `/transcript model set model:<model>`             | Validate an installed model and save it as the default for future recordings.             |

Reject duplicate starts and attempts to use a second voice channel in the same server while a session is active. Check the ability to view/connect to the channel and send messages, embeds, and attachments there before starting. Join with audio reception enabled (`selfDeaf: false`). Use Guilds and GuildVoiceStates intents; this interaction design does not require reading ordinary message content.

### Recording control message

Send one embed with two action rows: the Status and Stop Recording buttons in the first row, and a single-select string dropdown in the second. Use the existing embed-compatible component format rather than mixing embeds with Components V2.

The embed contains the recording state, start time, selected model, participant count, distinct captured speaker count, and transcription progress. Status returns current details privately to the person clicking it. Stop Recording runs the same service and membership checks as the slash command.

Populate the dropdown from human members currently in the recorded voice channel. Sort by server display name with user ID as a deterministic tie-breaker; use `members.slice(0, 25)`. Option values are Discord user IDs, with display names and existing aliases shown in labels/descriptions within Discord's length limits. Disambiguate duplicate labels with usernames or IDs. Explain when the menu shows only the first 25 members; the slash command can address the remaining current members.

Selecting a member opens a modal prefilled with the current alias. Submitting sets the alias; an empty submission can clear it. Validate membership and permissions again on submission because either participant may have left while the modal was open. Trim and limit aliases, reject multiline/control-character input, and prevent unintended mentions when displaying user-entered text.

Debounce and serialize message edits triggered by joins, departures, display-name changes, alias changes, and lifecycle changes. Disable the dropdown when nobody is eligible, using a valid disabled placeholder option. Disable recording controls during finalization and after completion. Route interactions centrally using session-aware custom IDs; expired controls should return a useful response rather than depending on an in-memory collector surviving forever.

Discord string selects accept at most 25 options. A manually populated string select allows the menu to be restricted to current voice-channel members. Source: [component reference](https://docs.discord.com/developers/components/reference#string-select).

## Persistent data

Use a local SQLite database with migrations and transactions. Keep Discord IDs as strings.

| Record              | Key and relevant fields                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server settings     | `guild_id`; model identifier, language, updated timestamp.                                                                    |
| Transcript aliases  | `(guild_id, user_id)`; alias, editor user ID, updated timestamp.                                                              |
| Sessions            | session ID; guild/channel/control-message IDs, start/end times, lifecycle state, stop reason, model snapshot, delivery state. |
| Participants        | `(session_id, user_id)`; captured display name and final transcript-name snapshot.                                            |
| Audio jobs          | job ID; session/user IDs, chunk sequence, capture offset, duration, audio path, state, retry count.                           |
| Transcript segments | job/segment identity; session/user IDs, start/end offsets, text.                                                              |

Persist jobs before scheduling them and use unique identities to prevent duplicate transcript rows on retries. Keep large audio data on disk, not in the database or an unbounded in-memory queue. Migrations, database access, alias behavior, and model settings belong outside Discord command handlers.

At recording start, snapshot the exact selected model and language. A model-setting change affects future recordings, including after restart; it does not switch an active session midway. At finalization, snapshot aliases for all captured participants, including people who already left. Resolve each name as alias, then captured display name, then user ID. This keeps names consistent despite job completion order.

## Audio and transcription pipeline

1. Join and wait for a ready voice connection. Establish a wall-clock start time for the transcript header and a monotonic clock for elapsed speech timing.
2. Subscribe to each human speaker's received stream by Discord user ID, including late joiners. Maintain independent decoders and chunk state; avoid duplicate subscriptions.
3. Decode Opus and convert to mono 16 kHz, 16-bit WAV. End a chunk after a configurable silence period and enforce a maximum chunk duration for continuous speech. Keep enough boundary context to avoid clipping words and deduplicate any deliberate overlap.
4. Preserve silence and capture offsets within chunks. Never concatenate separated bursts without a timing map; doing so would incorrectly compress transcript timestamps. Derive timing from received audio and the session clock, not from transcription completion time.
5. Persist chunk metadata and enqueue transcription. Apply voice activity/silence filtering to reduce empty jobs and hallucinated speech.
6. Start with one shared transcription worker and a configurable CPU thread budget that leaves headroom for Discord reception. Invoke whisper.cpp outside Node's event loop with argument arrays, timeouts, and bounded retries. Start with the CLI adapter; benchmark repeated model loading and move to a persistent local worker only if needed.
7. Parse structured Whisper JSON, validate it, and add each chunk's capture offset to recognized segment offsets.
8. Persist recognized segments and release temporary audio according to retention policy.

Capture all active speakers independently even if transcription falls behind. Queue on disk, report pending work, and continue finalization after capture ends. Do not start one large model instance per participant. Benchmark three simultaneous streams; total participant count mainly affects subscriptions, metadata, and the menu. Monitor disk capacity and stop with an explicit partial-result explanation if a configured storage limit is reached rather than silently discarding audio.

Whisper model names include `tiny`, `base`, `small`, `medium`, `large-v3`, and `large-v3-turbo`, plus applicable English-only and quantized variants. Present `base` as the canonical name for the requested basic tier and map a friendly `large` choice to an explicit version. Keep a model registry with validated local file paths; do not silently downgrade models or accept arbitrary executable arguments. Document model downloads separately and reject missing models with a helpful setup instruction.

CPU throughput must be measured. Medium and large models may create substantial processing delays on this machine; the status UI must accurately show pending work without promising real-time completion.

Sources: [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [available models](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md), [CLI output options](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/README.md).

## Session lifecycle and stopping

Normal states: `connecting -> recording -> stopping -> finalizing -> completed`. Represent failure and interrupted sessions explicitly.

- Maintain one idempotent stop path for commands, buttons, empty-channel timeout, shutdown, bot removal/move, and unrecoverable voice errors.
- Start the 30-second grace timer only when no human members remain. Ignore every bot for this calculation.
- Cancel the timer when a human returns; at expiry recheck membership and session identity before stopping. Silence is not emptiness.
- On manual stop, establish a capture cutoff immediately, unsubscribe receivers, flush partial chunks, and disconnect. Do not keep receiving while transcription finishes.
- Track transcription progress independently from connection state, updating the same control message through finalization.
- On a short recoverable voice disconnect, attempt bounded recovery and record any known gap. On an unrecoverable disconnect or a forced move, finalize the original session and identify it as partial rather than silently recording another channel.
- On restart, mark abandoned capture sessions interrupted, recover persisted jobs when their files exist, and attempt delivery of recoverable results. Do not automatically resume recording.

## Transcript and delivery

Example:

```text
Session started: 2026-10-20T19:30:00Z
Voice channel: General
Model: base.en
Timestamps: elapsed since recording started

[00:00:03.200–00:00:06.850] Insert Name: Let's review the deployment.
[00:00:04.100–00:00:05.900] Alex: I have the notes ready.
```

Sort by speech start time with deterministic tie-breakers. Preserve overlapping timestamp ranges. Add a participant identity legend so identical aliases can be distinguished. Mark known gaps, failed chunks, or interrupted sessions without inventing missing speech.

Send the final `.txt` attachment to the same voice channel ID's chat, even if the recording started via a slash command elsewhere. Split oversized transcripts into ordered text files using the applicable attachment limit. Update the original control message to completed with the result location. Save delivery state and retain undelivered output for retry if permissions change or Discord rejects an upload.

## Repository structure

```text
src/
  index.ts                     # Composition and startup/shutdown
  config/                      # Validated environment and runtime configuration
  discord/
    commands/                  # Slash-command adapters
    interactions/              # Buttons, dropdowns, modals
    events/                    # Voice-state and connection events
    views/                     # Embed and component builders
  sessions/                    # Lifecycle, authorization, empty-channel timer
  audio/                       # Capture, decoding, timing, chunking
  transcription/               # Model registry, Whisper adapter, job scheduling
  transcripts/                 # Alias resolution, rendering, delivery service
  storage/
    migrations/
    repositories/              # SQLite access and filesystem storage
  shared/                      # Small shared types, errors, clock, logging
tests/
  unit/
  integration/
  fixtures/
scripts/                       # Command registration, model setup, benchmarking
docs/
data/                          # Ignored database, sessions, jobs, output
models/                        # Ignored model downloads
```

Add a lockfile, strict TypeScript setup, linting/formatting, `.env.example`, project-appropriate ignore rules, CI checks, and a README covering Discord app setup, permissions, local dependencies, models, commands, retention, recovery, and running as a local service. Logs should identify sessions/jobs without logging tokens, raw audio, or transcript contents by default.

## Implementation milestones and validation

1. **Feasibility:** pin a compatible Node/Discord voice stack; capture two separate encrypted speaker streams and transcribe a fixture locally. Benchmark likely CPU models and a three-stream workload.
2. **Foundation:** scaffold the TypeScript app, configuration, SQLite migrations, alias/settings repositories, command registration, and model registry. Verify persistence across a process restart and server isolation.
3. **Capture and lifecycle:** implement per-speaker chunking, late joiners, shared timing, manual stop, and the empty-channel timer. Verify leave/rejoin races, simultaneous stop requests, and final partial chunks.
4. **Discord controls:** implement the voice-chat control embed, buttons, alias dropdown/modal, debounced updates, permission checks, and stale interactions. Verify menu sizes at 0, 1, 25, and 26+ humans, duplicate names, alias clearing, and departures during modal entry.
5. **Transcription and output:** connect durable jobs to whisper.cpp, timestamp merging, alias snapshots, text rendering, and attachment delivery. Verify three overlapping speakers, 20+ distinct speaker identities, delayed/out-of-order jobs, failed retries, and large-file splitting.
6. **Recovery and operations:** verify interrupted sessions, failed uploads, disk limits, retention, graceful shutdown, and a live Discord smoke test. Complete setup documentation and CI.

Use a fake clock for timer tests, temporary SQLite databases for persistence tests, and synthetic or explicitly provided audio fixtures for pipeline tests. Keep ordinary CI independent of Discord credentials and large model downloads; maintain separate opt-in live voice and actual-model checks.
