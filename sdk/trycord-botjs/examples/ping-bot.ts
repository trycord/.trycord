// A bot that answers "!ping".
//
// The smallest thing that is a bot: it listens for a message and writes one
// back. Everything else - the community, the channel - is read from the
// event, so the same code works in any community the application is in.
//
//     TRYCORD_BOT_TOKEN=trcd_bot_... npx tsx ping-bot.ts
//     TRYCORD_BOT_TOKEN=... TRYCORD_BASE_URL=https://chat.example.org npx tsx ping-bot.ts

import { Client, Events } from 'trycord-botjs';

const client = new Client({
  token: process.env.TRYCORD_BOT_TOKEN!,
  baseUrl: process.env.TRYCORD_BASE_URL || 'https://trycord.dev',
});

client.on(Events.MessageCreated, async (event) => {
  const message = event.message;
  // A bot's own messages come back over the gateway, and answering them
  // would be a loop.
  if (!message || message.author_is_bot) return;
  if (message.content.trim().toLowerCase() !== '!ping') return;
  await client.send(event.serverId!, event.channelId!, 'Pong.');
});

client.on('__ready', () => {
  console.log('the bot is listening');
});

await client.login();
console.log('connected');
