# Live Discord acceptance test

Automated tests cover native Opus decoding, chunk timing, persistence, menu limits, the transcription queue, session lifecycle, and recovery. Actual voice reception requires a Discord bot token, a server, and human speakers. Discord does not guarantee the undocumented receive interface; repeat this test after updating voice dependencies.

1. Run `npm run doctor` and `npm run smoke:whisper`. Register commands and start the bot as described in the README.
2. Put at least two people in a regular voice channel. Run `/transcript start` from another text channel. Confirm the bot joins and posts its control embed in the voice channel's chat.
3. Speak distinct sentences separately and simultaneously. Confirm Status shows captured speakers and pending/processed chunks. Check the bot never mixes speaker identities in the final text.
4. Select a member in the dropdown and submit an alias. Change it again through `/transcript alias set`. Clear another alias by submitting a blank modal. Have a member leave while their alias modal is open; verify submission is rejected.
5. Have members join/leave. Confirm the existing embed updates rather than posting another control message. Verify that a 26-person call produces exactly 25 sorted human options, with access to other current members through slash commands.
6. Click Stop Recording as a participant. Confirm reception stops immediately, the bot disconnects, and processing continues until the text attachment appears in the original voice channel's chat. Try clicking as someone outside the call and verify rejection.
7. Start again, have every human leave for 29 seconds, and return. Verify the bot keeps recording. Leave again for more than 30 seconds and verify auto-stop. A remaining bot must not prevent auto-stop; a silent human must prevent it.
8. Change the model while recording. Confirm the active session keeps its original model and the next session uses the new setting. Restart the process and verify both model/language settings and aliases persist.
9. Install `base`, enable another language in `config/bot.json`, select the multilingual model, and select `auto` or the added language. Verify original-language transcription and useful rejection of incompatible `.en` models.
10. Disconnect or forcibly move the bot. Confirm it finalizes a partial recording and does not silently record a different channel. Interrupt the process with pending work, restart, and confirm recovery delivers the captured portion without resuming capture.
11. Temporarily revoke Attach Files before stopping. Confirm the transcript remains in `data/sessions/<session-id>/transcript.txt`. Restore permission and verify automatic retry or `npm run retry-delivery` succeeds.

Record the dependency versions, selected model, CPU thread count, approximate duration, speaker count, and any timing gaps observed. No Discord live acceptance test has been performed until bot credentials and a test call are supplied.
