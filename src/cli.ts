import { db } from './index';
import { addChannel, listChannels, removeChannel } from './db/watchlist';
import { pollChannel } from './poll';
import { enqueuePollRun } from './poll-scheduler';
import { workerProcessRun } from './poll-worker';
import { deleteVideo } from './delete-video';

function main() {
  // Find args after the script file (works with both `node` and `tsx` which may use full paths)
  const scriptIdx = process.argv.findIndex((a) => a.includes('cli.ts'));
  const args = scriptIdx >= 0 ? process.argv.slice(scriptIdx + 1) : process.argv.slice(2);
  const [command, subcommand, channelId] = args;

  switch (command) {
    case 'watchlist':
      handleWatchlist(subcommand, channelId);
      break;
    case 'poll':
      handlePoll(subcommand, channelId);
      break;
    case 'delete-video':
      handleDeleteVideo(subcommand);
      break;
    default:
      console.error('Usage: tsx src/cli.ts <watchlist|poll|delete-video> ...');
      process.exit(1);
  }
}

async function handlePoll(subcommand: string | undefined, channelId: string | undefined) {
  // no args -> multi-channel poll via queue+worker
  if (!subcommand) {
    try {
      const runId = enqueuePollRun(db);
      console.log(`Enqueued poll run ${runId}`);
      await workerProcessRun(db, runId);
      const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
      console.log(`Poll run ${runId} complete: ${run.status}, ${run.new_signal_count} new signals`);
    } catch (err) {
      console.error(`Poll failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand !== '--channel' || !channelId) {
    console.error('Usage: tsx src/cli.ts poll [--channel <channel_id>]');
    process.exit(1);
  }

  try {
    const result = await pollChannel(db, channelId);
    console.log(`Poll complete for ${channelId}:`);
    console.log(`  New signals: ${result.newSignals}`);
    console.log(`  Skipped (duplicate): ${result.skippedDuplicates}`);
    if (result.skippedNoCaptions.length > 0) {
      console.log(`  Skipped (no captions): ${result.skippedNoCaptions.join(', ')}`);
    }
  } catch (err) {
    console.error(`Poll failed: ${(err as Error).message}`);
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

function handleDeleteVideo(videoId: string | undefined) {
  if (!videoId) {
    console.error('Usage: tsx src/cli.ts delete-video <video_id>');
    process.exit(1);
  }

  const deleted = deleteVideo(db, videoId);
  if (deleted) {
    console.log(`Deleted video ${videoId} and all related entity mentions.`);
  } else {
    console.error(`Video ${videoId} not found in database.`);
    process.exit(1);
  }
}

main();
