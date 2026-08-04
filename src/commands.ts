// commands.ts — Discord slash-command definitions + guild registration.
//
// The bot's utility features are real slash commands (not parsed chat), so their
// replies can be ephemeral — visible only to you, never cluttering the channel.
// The command *definitions* live here (plain data, easy to eyeball); the routing
// that answers them lives in the InteractionCreate handler in index.ts.

import { Client, SlashCommandBuilder } from "discord.js";

import { SLOTS } from "./habits";

// Slash names must be lowercase; the slot choices double as the `/slot` and
// `/add-habit` dropdown options.
const slotChoices = SLOTS.map((s) => ({ name: s, value: s }));

// The full command surface, as JSON ready for `guild.commands.set`.
export const commandDefinitions = [
  new SlashCommandBuilder().setName("summary").setDescription("Today's progress — done + what's left"),
  new SlashCommandBuilder()
    .setName("slot")
    .setDescription("What's left in one time slot")
    .addStringOption((o) =>
      o.setName("slot").setDescription("Which check-in").setRequired(true).addChoices(...slotChoices),
    ),
  new SlashCommandBuilder()
    .setName("gratitude")
    .setDescription("Write or edit today's gratitude entry"),
  new SlashCommandBuilder()
    .setName("add-habit")
    .setDescription("Track a new habit in a time slot")
    .addStringOption((o) =>
      o.setName("slot").setDescription("Which check-in").setRequired(true).addChoices(...slotChoices),
    )
    .addStringOption((o) => o.setName("name").setDescription("Habit name").setRequired(true))
    .addStringOption((o) => o.setName("emoji").setDescription("Optional leading emoji")),
  new SlashCommandBuilder()
    .setName("undo")
    .setDescription("Reverse today's check-off for a habit")
    .addStringOption((o) =>
      o.setName("habit").setDescription("Habit keyword, e.g. water").setRequired(true),
    ),
  new SlashCommandBuilder().setName("audible").setDescription("Check today's Audible minutes"),
  new SlashCommandBuilder().setName("help").setDescription("How the bot works + the commands"),
].map((c) => c.toJSON());

// Register the commands on a single guild (instant availability — global
// commands can take up to an hour to propagate). Requires the bot to have been
// invited with the `applications.commands` scope; throws "Missing Access" if not.
export const registerGuildCommands = async (client: Client, guildId: string): Promise<void> => {
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set(commandDefinitions);
  console.log(`Registered ${commandDefinitions.length} slash commands on guild ${guildId}.`);
};
