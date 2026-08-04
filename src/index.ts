// index.ts — the accountability bot (Discord wiring).
//
// Posts a daily check-in that @-mentions you, then listens for your replies in
// the target channel. When a reply mentions a habit's keyword, that habit is
// checked off for the day and its streak is updated. A later "nudge" fires only
// if the day's list isn't complete. All the decision logic lives in logic.ts.

import http from "node:http";
import cron from "node-cron";
import {
  Client,
  GatewayIntentBits,
  Events,
  TextChannel,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ButtonComponent,
  ComponentType,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";

import {
  matchedHabits,
  fireEmoji,
  timeToCron,
  buildDailyPrompt,
  buildCategoryPrompt,
  remainingHabits,
  buildReminder,
  buildSummary,
  buildSlotSummary,
  buildHelp,
  buildGratitudeModal,
  buildGratitudeConfirm,
  buildGratitudeEntryCard,
  buildVerseOfDay,
  GRATITUDE_HABIT_ID,
  GRATITUDE_ADD_ID,
  GRATITUDE_MODAL_ID,
  GRATITUDE_INPUT_ID,
  SLOT_INFO,
  card,
  simpleCard,
  COLORS,
  BotMessage,
} from "./logic";
import { addHabitFromInput, findHabit, SLOTS, TimeSlot } from "./habits";
import { registerGuildCommands } from "./commands";
import * as store from "./store";
import * as audible from "./audible";
import * as votd from "./votd";
import * as ingest from "./ingest";
import { createIngestListener } from "./http";

// ---------- config / env ----------

const must = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
};

const DISCORD_TOKEN = must("DISCORD_TOKEN");
const CHANNEL_ID = must("CHANNEL_ID");
const USER_ID = must("USER_ID");

const TZ = process.env.TZ ?? "UTC";

// One scheduled check-in per time slot, each pinging that slot's habits.
const SLOT_TIMES: Record<TimeSlot, string> = {
  morning: process.env.MORNING_TIME ?? "07:00",
  afternoon: process.env.AFTERNOON_TIME ?? "12:00",
  evening: process.env.EVENING_TIME ?? "17:00",
};
const REMINDER_TIME = process.env.REMINDER_TIME ?? "20:00"; // end-of-day nudge, only if the list isn't complete
const SEND_NOW = process.env.SEND_NOW; // "1" → fire one prompt immediately at startup (testing)
const READING_MINUTES = Number(process.env.READING_MINUTES ?? "30"); // Audible threshold for auto-check-off

// Samsung Health ingest: the HTTP endpoints only start if INGEST_TOKEN is set
// (inert otherwise, like the Audible integration). PORT is injected by Railway.
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const PORT = Number(process.env.PORT ?? "3000");

// Optional gratitude journal channel: when set, each saved entry is mirrored here
// as a per-day card (edited in place on later edits). Unset → no mirroring.
const GRATITUDE_CHANNEL_ID = process.env.GRATITUDE_CHANNEL_ID;

// Optional Verse of the Day (YouVersion). Enabled only when both the app key and a
// target channel are set; posts a KJV verse card at VOTD_TIME each day.
const VOTD_CHANNEL_ID = process.env.VOTD_CHANNEL_ID;
const VOTD_TIME = process.env.VOTD_TIME ?? "08:00";
const BIBLE_VERSION_ID = process.env.BIBLE_VERSION_ID ?? "1"; // 1 = KJV (public domain)
const BIBLE_VERSION_LABEL = process.env.BIBLE_VERSION_LABEL ?? "KJV";
const VOTD_ENABLED = votd.isConfigured() && !!VOTD_CHANNEL_ID;

// Fail fast at startup if any schedule time is malformed.
const slotExprs: Record<TimeSlot, string> = {
  morning: timeToCron(SLOT_TIMES.morning),
  afternoon: timeToCron(SLOT_TIMES.afternoon),
  evening: timeToCron(SLOT_TIMES.evening),
};
const reminderExpr = timeToCron(REMINDER_TIME);
const votdExpr = VOTD_ENABLED ? timeToCron(VOTD_TIME) : null;

// ---------- discord wiring ----------

// Only the Guilds intent is needed: the bot posts messages (no intent required to
// send) and everything the user does is an interaction (slash commands, buttons,
// modals). Free-text check-off is gone, so the privileged Message Content intent
// can be turned OFF in the dev portal.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const sendMessage = async (payload: BotMessage): Promise<void> => {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isTextBased()) {
    throw new Error(`Channel ${CHANNEL_ID} is not a text channel the bot can post in.`);
  }
  await (channel as TextChannel).send({
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components ?? [],
    allowedMentions: { users: [USER_ID] }, // only ping the one user
  });
};

// Mirror today's gratitude entry into the optional journal channel as a per-day
// card. Edits the existing message in place (one card per day) so the channel
// reads as a clean archive; posts a fresh card if there isn't one yet. Best-effort:
// any failure is logged and swallowed so it never breaks the interaction reply.
const mirrorGratitudeToChannel = async (text: string, streak: number): Promise<void> => {
  if (!GRATITUDE_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(GRATITUDE_CHANNEL_ID);
    if (!channel?.isTextBased() || !("send" in channel)) {
      console.error(`Gratitude channel ${GRATITUDE_CHANNEL_ID} isn't a text channel the bot can post in.`);
      return;
    }
    const day = store.todayStr(TZ);
    const cardMsg = buildGratitudeEntryCard(day, text, streak);
    const existingId = store.getGratitudeMessageId(TZ);
    if (existingId) {
      try {
        const msg = await channel.messages.fetch(existingId);
        await msg.edit({ embeds: cardMsg.embeds });
        return;
      } catch {
        // The stored message was deleted or is unreachable — fall through to repost.
      }
    }
    const sent = await (channel as TextChannel).send({ embeds: cardMsg.embeds });
    store.setGratitudeMessageId(sent.id, TZ);
  } catch (err) {
    console.error("Failed to mirror gratitude entry to channel:", err);
  }
};

// Fetch today's Verse of the Day and post it (no mention) to the VOTD channel.
// Best-effort: any API/network failure is logged and skipped so the bot stays up.
const postVerseOfTheDay = async (): Promise<void> => {
  if (!VOTD_ENABLED || !VOTD_CHANNEL_ID) return;
  try {
    const verse = await votd.fetchVerseOfTheDay(TZ, BIBLE_VERSION_ID, process.env.YOUVERSION_APP_KEY!);
    const channel = await client.channels.fetch(VOTD_CHANNEL_ID);
    if (!channel?.isTextBased() || !("send" in channel)) {
      console.error(`VOTD channel ${VOTD_CHANNEL_ID} isn't a text channel the bot can post in.`);
      return;
    }
    await (channel as TextChannel).send({
      embeds: buildVerseOfDay(verse, BIBLE_VERSION_LABEL).embeds,
      allowedMentions: { parse: [] }, // devotional post — never ping anyone
    });
    console.log(`[${new Date().toISOString()}] Posted verse of the day (${verse.reference}).`);
  } catch (err) {
    console.error("Failed to post verse of the day:", err);
  }
};

const sendDailyPrompt = async (): Promise<void> => {
  try {
    await sendMessage(buildDailyPrompt(USER_ID, TZ));
    console.log(`[${new Date().toISOString()}] Sent daily prompt.`);
  } catch (err) {
    console.error("Failed to send daily prompt:", err);
  }
};

// The per-slot check-in (morning / afternoon / evening).
const sendCategoryPrompt = async (slot: TimeSlot): Promise<void> => {
  try {
    await sendMessage(buildCategoryPrompt(USER_ID, TZ, slot));
    console.log(`[${new Date().toISOString()}] Sent ${slot} check-in.`);
  } catch (err) {
    console.error(`Failed to send ${slot} check-in:`, err);
  }
};

// The evening nudge: only fires if some habits are still incomplete for the day.
const sendReminderIfIncomplete = async (): Promise<void> => {
  try {
    const remaining = remainingHabits(TZ);
    if (remaining.length === 0) {
      console.log(`[${new Date().toISOString()}] All habits complete — skipping reminder.`);
      return;
    }
    await sendMessage(buildReminder(USER_ID, remaining, TZ));
    console.log(`[${new Date().toISOString()}] Sent reminder (${remaining.length} remaining).`);
  } catch (err) {
    console.error("Failed to send reminder:", err);
  }
};

// ---------- Samsung Health ingest HTTP server ----------

// Announce each newly-completed metric in Discord (once — only when checkedOff).
const announceIngest = async (results: ingest.MetricResult[]): Promise<void> => {
  for (const r of results) {
    if (!r.checkedOff) continue;
    const value = Number.isInteger(r.valueToday) ? r.valueToday : Number(r.valueToday.toFixed(2));
    try {
      await sendMessage(
        simpleCard(
          COLORS.done,
          `📲 Samsung Health → ${r.name}`,
          `Auto-checked off ${r.emoji} **${r.name}** — ${value}/${r.goal} ${r.unit} today. ${fireEmoji(r.currentStreak)}`,
        ),
      );
    } catch (err) {
      console.error("Failed to announce ingest check-off:", err);
    }
  }
};

// Start the ingest listener — but only when a token is configured, so existing
// deploys that don't set INGEST_TOKEN keep running as a pure background worker.
// The request handling lives in ./http; here we just inject the Discord announce.
//
// This runs independently of the Discord connection (see the entrypoint below) so
// the endpoints — including the unauthenticated /healthz probe — stay up even if
// Discord login is slow or failing. If a push lands before the client is ready, the
// habit is still checked off; only the Discord announcement no-ops (it's caught).
const startIngestServer = (): void => {
  if (!INGEST_TOKEN) {
    console.log("Samsung Health ingest disabled (no INGEST_TOKEN).");
    return;
  }
  const listener = createIngestListener({
    token: INGEST_TOKEN,
    tz: TZ,
    onResults: (results) => void announceIngest(results),
  });
  http.createServer(listener).listen(PORT, () =>
    console.log(`Samsung Health ingest listening on :${PORT}`),
  );
};

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Register the slash commands on the guild that owns the configured channel, so
  // they show up instantly. Needs the bot invited with the `applications.commands`
  // scope — a failure here (e.g. "Missing Access") means it needs re-inviting.
  void (async () => {
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      const guildId = channel && "guildId" in channel ? channel.guildId : null;
      if (!guildId) {
        console.error("Could not resolve a guild from CHANNEL_ID — slash commands not registered.");
        return;
      }
      await registerGuildCommands(client, guildId);
    } catch (err) {
      console.error(
        "Failed to register slash commands (re-invite the bot with the applications.commands scope?):",
        err,
      );
    }
  })();

  for (const slot of SLOTS) {
    cron.schedule(slotExprs[slot], () => void sendCategoryPrompt(slot), { timezone: TZ });
    console.log(
      `Scheduled ${slot} check-in at ${SLOT_TIMES[slot]} (${TZ}) — cron "${slotExprs[slot]}"`,
    );
  }

  cron.schedule(reminderExpr, sendReminderIfIncomplete, { timezone: TZ });
  console.log(`Scheduled catch-up nudge at ${REMINDER_TIME} (${TZ}) — cron "${reminderExpr}"`);

  // Audible: if credentials are configured, poll hourly to auto-check-off Reading.
  if (audible.isConfigured()) {
    const audibleJob = async (): Promise<void> => {
      try {
        const r = await audible.pollAudible(TZ, READING_MINUTES);
        if (r.checkedOff) {
          await sendMessage(
            simpleCard(
              COLORS.done,
              "🎧 Audible → Reading",
              `Auto-checked off **reading** — ${Math.round(r.minutesToday)} min on Audible today. 🔥 ${r.currentStreak}`,
            ),
          );
          console.log(`[audible] checked off reading (${Math.round(r.minutesToday)} min today).`);
        }
      } catch (err) {
        console.error("[audible] poll failed:", err);
      }
    };
    cron.schedule("0 * * * *", audibleJob, { timezone: TZ }); // top of every hour
    void audibleJob(); // catch up once at startup
    console.log(`Audible integration enabled — polling hourly (threshold ${READING_MINUTES} min).`);
  } else {
    console.log("Audible integration disabled (no credentials).");
  }

  console.log(
    GRATITUDE_CHANNEL_ID
      ? `Gratitude journal channel enabled — mirroring entries to ${GRATITUDE_CHANNEL_ID}.`
      : "Gratitude journal channel disabled (no GRATITUDE_CHANNEL_ID).",
  );

  if (votdExpr) {
    cron.schedule(votdExpr, () => void postVerseOfTheDay(), { timezone: TZ });
    console.log(
      `Verse of the Day enabled — posting to ${VOTD_CHANNEL_ID} at ${VOTD_TIME} (${TZ}), ` +
        `${BIBLE_VERSION_LABEL} (version ${BIBLE_VERSION_ID}).`,
    );
  } else {
    console.log("Verse of the Day disabled (needs YOUVERSION_APP_KEY + VOTD_CHANNEL_ID).");
  }

  if (SEND_NOW === "1") {
    console.log("SEND_NOW=1 → sending one prompt now.");
    void sendDailyPrompt();
    if (votdExpr) void postVerseOfTheDay();
  }
});

// Reply to a slash command with a private (ephemeral) card built by logic.ts.
const replyEphemeral = async (
  interaction: ChatInputCommandInteraction,
  msg: BotMessage,
): Promise<void> => {
  await interaction.reply({
    content: msg.content,
    embeds: msg.embeds,
    components: msg.components ?? [],
    flags: MessageFlags.Ephemeral,
  });
};

// The single interaction router: slash commands, buttons, and modal submits.
// Everything is gated to the tracked user (this is a personal accountability bot)
// and every command reply is ephemeral, so nothing lands in the channel.
client.on(Events.InteractionCreate, async (interaction) => {
  if (
    (interaction.isChatInputCommand() || interaction.isButton() || interaction.isModalSubmit()) &&
    interaction.user.id !== USER_ID
  ) {
    if (!interaction.isModalSubmit()) {
      await interaction.reply({ content: "This bot is personal 🙂", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
    return;
  }

  if (interaction.isButton()) {
    // Gratitude is written, not tapped: its button opens the modal.
    if (interaction.customId === GRATITUDE_ADD_ID) {
      await interaction.showModal(buildGratitudeModal(store.getGratitude(TZ)));
      return;
    }

    const [action, habitId] = interaction.customId.split(":");
    if (action !== "check" || !habitId) return;

    const habit = findHabit(habitId);
    if (!habit) {
      await interaction.reply({ content: "That habit isn't tracked anymore.", flags: MessageFlags.Ephemeral });
      return;
    }

    const res = store.checkOff(habit.id, TZ);
    // Rebuild the message's button rows, flipping just the tapped one to done.
    const rows = interaction.message.components
      .filter((row) => row.type === ComponentType.ActionRow)
      .map((row) => {
        const rebuilt = new ActionRowBuilder<ButtonBuilder>();
        for (const comp of row.components) {
          if (!(comp instanceof ButtonComponent)) continue;
          const button = ButtonBuilder.from(comp);
          if (comp.customId === interaction.customId) {
            button.setStyle(ButtonStyle.Success).setDisabled(true).setLabel(`✅ ${habit.name}`.slice(0, 80));
          }
          rebuilt.addComponents(button);
        }
        return rebuilt;
      });
    await interaction.update({ components: rows });
    const note = res.alreadyDone
      ? `${habit.emoji} **${habit.name}** was already done today.`
      : `${habit.emoji} **${habit.name}** checked off — ${fireEmoji(res.currentStreak)}`;
    await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === GRATITUDE_MODAL_ID) {
    const text = interaction.fields.getTextInputValue(GRATITUDE_INPUT_ID).trim();
    store.setGratitude(text, TZ);
    const res = store.checkOff(GRATITUDE_HABIT_ID, TZ);
    const confirm = buildGratitudeConfirm(text, res.currentStreak);

    // If the modal was opened from a prompt/nudge button, flip that button green
    // in place (kept tappable for edits), then confirm privately. Otherwise (from
    // the /gratitude command) there's no source message — just confirm.
    if (interaction.isFromMessage()) {
      const habit = findHabit(GRATITUDE_HABIT_ID);
      // Flip the gratitude button green but keep it enabled so the entry stays editable.
      const rows = interaction.message.components
        .filter((row) => row.type === ComponentType.ActionRow)
        .map((row) => {
          const rebuilt = new ActionRowBuilder<ButtonBuilder>();
          for (const comp of row.components) {
            if (!(comp instanceof ButtonComponent)) continue;
            const button = ButtonBuilder.from(comp);
            if (comp.customId === GRATITUDE_ADD_ID) {
              button
                .setStyle(ButtonStyle.Success)
                .setLabel(`✅ ${habit?.name ?? "Gratitude journal"}`.slice(0, 80));
            }
            rebuilt.addComponents(button);
          }
          return rebuilt;
        });
      await interaction.update({ components: rows });
      await interaction.followUp({ ...confirm, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ ...confirm, flags: MessageFlags.Ephemeral });
    }

    // Mirror to the journal channel last — the interaction is already acknowledged,
    // so a slow/failed channel post can't delay or break the private confirmation.
    await mirrorGratitudeToChannel(text, res.currentStreak);
    return;
  }
});

// ---------- slash command handlers ----------

const handleCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  switch (interaction.commandName) {
    case "summary":
      await replyEphemeral(interaction, buildSummary(TZ));
      return;

    case "slot": {
      const slot = interaction.options.getString("slot", true) as TimeSlot;
      await replyEphemeral(interaction, buildSlotSummary(TZ, slot));
      return;
    }

    case "help":
      await replyEphemeral(
        interaction,
        buildHelp({
          morning: SLOT_TIMES.morning,
          afternoon: SLOT_TIMES.afternoon,
          evening: SLOT_TIMES.evening,
          reminder: REMINDER_TIME,
        }),
      );
      return;

    case "gratitude":
      await interaction.showModal(buildGratitudeModal(store.getGratitude(TZ)));
      return;

    case "add-habit": {
      const slot = interaction.options.getString("slot", true);
      const name = interaction.options.getString("name", true);
      const emoji = interaction.options.getString("emoji") ?? "";
      // Reuse the existing parser/validator by reconstructing its "slot [emoji] name" input.
      const res = addHabitFromInput(`${slot} ${emoji} ${name}`.replace(/\s+/g, " ").trim());
      if (!res.ok) {
        await replyEphemeral(interaction, simpleCard(COLORS.undo, "➕ Add Habit", res.error!));
        return;
      }
      const h = res.habit!;
      const slotInfo = SLOT_INFO[h.slot];
      const embed = card(COLORS.done, "➕ Habit Added")
        .setDescription(
          `${h.emoji} **${h.name}** is now tracked in your ${slotInfo.emoji} ` +
            `**${slotInfo.label}** check-in (${SLOT_TIMES[h.slot]}).`,
        )
        .addFields({
          name: "✅ How it works",
          value: "It'll appear as a tappable button on that slot's check-in.",
        });
      await replyEphemeral(interaction, { embeds: [embed] });
      return;
    }

    case "undo": {
      const arg = interaction.options.getString("habit", true).trim();
      const targets = matchedHabits(arg);
      if (targets.length === 0) {
        await replyEphemeral(
          interaction,
          simpleCard(COLORS.undo, "↩️ Undo", "I couldn't tell which habit that is — try a habit keyword."),
        );
        return;
      }
      const lines = targets.map((habit) => {
        const res = store.uncheck(habit.id, TZ);
        if (!res.wasDone) return `${habit.emoji} **${habit.name}** wasn't checked off today.`;
        const streak = res.currentStreak > 0 ? fireEmoji(res.currentStreak) : "no active streak";
        return `${habit.emoji} **${habit.name}** unchecked — ${streak}`;
      });
      await replyEphemeral(interaction, {
        embeds: [card(COLORS.undo, "↩️ Undo").setDescription(lines.join("\n"))],
      });
      return;
    }

    case "audible": {
      if (!audible.isConfigured()) {
        await replyEphemeral(
          interaction,
          simpleCard(COLORS.audible, "🎧 Audible", "Audible isn't set up — no credentials configured."),
        );
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const r = await audible.pollAudible(TZ, READING_MINUTES);
        const mins = Math.round(r.minutesToday);
        let color: number = COLORS.audible;
        let description: string;
        if (r.checkedOff) {
          color = COLORS.done;
          description = `${mins} min on Audible today — **reading checked off!** 🔥 ${r.currentStreak}`;
        } else if (r.done) {
          color = COLORS.done;
          description = `${mins} min on Audible today — reading's already done today. ✅`;
        } else {
          const left = Math.max(0, READING_MINUTES - mins);
          description = `${mins} min on Audible today — ${left} more to hit ${READING_MINUTES}. 📖`;
        }
        await interaction.editReply({ embeds: simpleCard(color, "🎧 Audible", description).embeds });
      } catch (err) {
        console.error("[audible] command failed:", err);
        await interaction.editReply({
          embeds: simpleCard(COLORS.audible, "🎧 Audible", "Couldn't reach Audible right now — try again in a bit.").embeds,
        });
      }
      return;
    }
  }
};

// Only start listeners/connections when run directly (production entrypoint), never
// on import. The ingest HTTP server starts first and independently of Discord, so the
// endpoints (and /healthz) are reachable even while the gateway is still connecting.
if (require.main === module) {
  startIngestServer();
  // Log a login failure instead of letting the rejection crash the process — that
  // would take the ingest server down with it. The endpoints stay up regardless.
  client.login(DISCORD_TOKEN).catch((err) => {
    console.error("Discord login failed (ingest endpoints still running):", err);
  });
}
