// A bot that answers a slash command the community declared.
//
// The command itself is not in the code: a community administrator declares
// it in the developer console, with the arguments and the answer. The bot
// only has to be in the community and carry the right scopes.
//
// This example shows the other half: a bot that reads the commands its
// application declares, and shows what they are.

import { Client, Events } from 'trycord-botjs';

const client = new Client({
  token: process.env.TRYCORD_BOT_TOKEN!,
  baseUrl: process.env.TRYCORD_BASE_URL || 'https://trycord.dev',
});

// The commands the application declares.
for (const command of await client.commands()) {
  console.log(`/${command.name} — ${command.description || 'no description'}`);
  for (const option of command.options || []) {
    console.log(`    ${option.name} (${option.type})${option.required ? ', required' : ''}`);
  }
}

// A message that begins with a slash is the community asking the bot to
// answer. The server routes it to the command the application declared.
client.on(Events.MessageCreated, async (event) => {
  const message = event.message;
  if (!message || message.author_is_bot) return;
  if (!message.content.trim().startsWith('/')) return;
  console.log('the community asked for', message.content.trim());
});

await client.login();
