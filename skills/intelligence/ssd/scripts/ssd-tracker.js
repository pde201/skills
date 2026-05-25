#!/usr/bin/env node
/**
 * ssd-tracker.js
 * Tracks speculative decoding performance in .acuity/ssd-cache.json
 */
const fs = require('fs');
const path = require('path');

function usage() {
  console.log(`SSD Speculation Tracker CLI

Usage:
  node ssd-tracker.js log --round <id> --status <status> --primary-ms <ms> --executor-ms <ms> [--reuse <ratio>] [--key <key>] [--reason <reason>]
  node ssd-tracker.js stats

Status Options:
  cache_hit, cache_miss, partial_branch_reuse, no_speculation
`);
  process.exit(1);
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        parsed[key] = val;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

const cacheDir = path.join(process.cwd(), '.acuity');
const cacheFile = path.join(cacheDir, 'ssd-cache.json');

function ensureCacheDir() {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

function readCache() {
  if (!fs.existsSync(cacheFile)) {
    return { rounds: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch (e) {
    return { rounds: [] };
  }
}

function writeCache(data) {
  ensureCacheDir();
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf8');
}

const command = process.argv[2];
if (!command) {
  usage();
}

const args = parseArgs(process.argv.slice(3));

if (command === 'log') {
  const { round, status, 'primary-ms': primaryMs, 'executor-ms': executorMs, reuse, key, reason } = args;

  if (!round || !status || primaryMs === undefined || executorMs === undefined) {
    console.error('❌ Error: Missing required log arguments.');
    usage();
  }

  const validStatuses = ['cache_hit', 'cache_miss', 'partial_branch_reuse', 'no_speculation'];
  if (!validStatuses.includes(status)) {
    console.error(`❌ Error: Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
    process.exit(1);
  }

  const cache = readCache();
  const newRound = {
    round_id: round,
    timestamp: new Date().toISOString(),
    cache_status: status,
    primary_ms: parseInt(primaryMs, 10),
    executor_ms: parseInt(executorMs, 10),
    reuse_ratio: parseFloat(reuse || '0'),
    outcome_key: key || null,
    cache_miss_reason: reason || (status === 'cache_hit' || status === 'no_speculation' ? 'none' : 'unknown')
  };

  cache.rounds.push(newRound);
  writeCache(cache);
  console.log(`✅ Successfully logged round "${round}" with status "${status}".`);

} else if (command === 'stats') {
  const cache = readCache();
  const rounds = cache.rounds || [];

  if (rounds.length === 0) {
    console.log('No speculation rounds logged yet.');
    process.exit(0);
  }

  const speculatedRounds = rounds.filter(r => r.cache_status !== 'no_speculation');
  const noSpecRounds = rounds.filter(r => r.cache_status === 'no_speculation');

  const totalSpec = speculatedRounds.length;
  const hits = speculatedRounds.filter(r => r.cache_status === 'cache_hit').length;
  const misses = speculatedRounds.filter(r => r.cache_status === 'cache_miss').length;
  const partials = speculatedRounds.filter(r => r.cache_status === 'partial_branch_reuse').length;

  console.log('=== Speculation Cache Metrics ===');
  console.log(`Total Logged Rounds: ${rounds.length}`);
  console.log(`Speculated Rounds  : ${totalSpec}`);
  console.log(`No Speculation     : ${noSpecRounds.length}`);

  if (totalSpec > 0) {
    const hitRate = (hits / totalSpec).toFixed(2);
    const missRate = (misses / totalSpec).toFixed(2);
    const partialRate = (partials / totalSpec).toFixed(2);
    
    let totalReuse = 0;
    speculatedRounds.forEach(r => totalReuse += r.reuse_ratio);
    const avgReuse = (totalReuse / totalSpec).toFixed(2);

    let timeSavedMs = 0;
    speculatedRounds.forEach(r => {
      if (r.cache_status === 'cache_hit') {
        // Hiding planning latency under executor time
        timeSavedMs += r.primary_ms;
      }
    });

    console.log(`Hit Rate           : ${hitRate} (${hits}/${totalSpec})`);
    console.log(`Miss Rate          : ${missRate} (${misses}/${totalSpec})`);
    console.log(`Partial Reuse Rate : ${partialRate} (${partials}/${totalSpec})`);
    console.log(`Avg Reuse Ratio    : ${avgReuse}`);
    console.log(`Est. Time Saved    : ${(timeSavedMs / 1000).toFixed(2)}s`);

    // Disable warnings checks
    console.log('\n=== Trigger Diagnostics ===');
    let warnings = [];

    // Rule 1: Hit rate below 0.30 over the last 5 rounds
    if (totalSpec >= 5) {
      const last5 = speculatedRounds.slice(-5);
      const last5Hits = last5.filter(r => r.cache_status === 'cache_hit').length;
      const last5HitRate = last5Hits / 5;
      if (last5HitRate < 0.30) {
        warnings.push(`⚠️ WARNING: Speculation hit rate is ${(last5HitRate * 100).toFixed(0)}% < 30% over the last 5 rounds.`);
      }
    }

    // Rule 2: primary_ms >= executor_ms for 2 consecutive rounds
    if (rounds.length >= 2) {
      const last2 = rounds.slice(-2);
      if (last2.every(r => r.primary_ms >= r.executor_ms)) {
        warnings.push('⚠️ WARNING: Primary draft latency >= executor time for 2 consecutive rounds (no overlap benefits).');
      }
    }

    // Rule 3: reuse_ratio < 0.25 on 2 matched-key rounds
    const matchedKeyRounds = speculatedRounds.filter(r => r.outcome_key !== null);
    if (matchedKeyRounds.length >= 2) {
      const last2Matched = matchedKeyRounds.slice(-2);
      if (last2Matched.every(r => r.reuse_ratio < 0.25)) {
        warnings.push('⚠️ WARNING: Reuse ratio < 0.25 on the last 2 matched outcome-key rounds.');
      }
    }

    if (warnings.length > 0) {
      warnings.forEach(w => console.warn(w));
      console.log('💡 Suggestion: Speculation economics are failing. Consider disabling speculative decoding.');
    } else {
      console.log('✅ Speculation performance is healthy and running within budget.');
    }
  }
} else {
  usage();
}
