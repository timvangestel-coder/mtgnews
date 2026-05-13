import { parseArgs } from 'node:util';
import { db } from './index';
import { addChannel, listChannels, removeChannel } from './db/watchlist';

function main() {
  const args = process.argv.slice(2);
  const [command, subcommand, channelId] = args;

  switch (command) {
    case 'watchlist':
      handleWatchlist(subcommand, channelId);
      break;
    default:
      console.error('Usage: tsx src/cli.ts watchlist <add|remove|list> [channel_id]');
      process.exit(1);
  }
}

function handleWatchlist(subcommand: string | undefined, channelId: string | undefined) {
  switch (subcommand) {
    case 'add':
      if (!channelId) {
        console.error('Usage: tsx src/cli.ts watchlist add <channel_id>');
        process.exit(1);
      }
      addChannel(db, channelId);
      console.log(`Added channel: ${channelId}`);
      break;

    case 'remove':
      if (!channelId) {
        console.error('Usage: tsx src/cli.ts watchlist remove <channel_id>');
        process.exit(1);
      }
      removeChannel(db, channelId);
      console.log(`Removed channel: ${channelId}`);
      break;

    case 'list':
      const channels = listChannels(db);
      if (channels.length === 0) {
        console.log('No channels in watchlist.');
      } else {
        console.log('Watched channels:');
        for (const ch of channels) {
          const date = new Date(ch.added_at).toISOString();
          console.log(`  ${ch.channel_id} | ${ch.display_name ?? '-'} | added: ${date}`);
        }
      }
      break;

    default:
      console.error('Usage: tsx src/cli.ts watchlist <add|remove|list> [channel_id]');
      process.exit(1);
  }
}

main();