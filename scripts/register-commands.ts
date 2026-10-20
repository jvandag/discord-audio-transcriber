import { REST, Routes } from 'discord.js';
import { credentials } from '../src/config/index.js';
import { command } from '../src/discord/commands.js';
const { DISCORD_TOKEN, DISCORD_APPLICATION_ID } = credentials();
const route = process.env.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_APPLICATION_ID, process.env.DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_APPLICATION_ID);
// POST upserts this command without deleting other commands registered to the application.
await new REST().setToken(DISCORD_TOKEN).post(route, { body: command.toJSON() });
console.log('Registered /transcript.');
