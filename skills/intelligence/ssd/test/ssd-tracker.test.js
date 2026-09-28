// Tests for scripts/ssd-tracker.js. Each test runs the CLI in its own
// temporary directory, where it keeps .acuity/ssd-cache.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TRACKER = path.join(__dirname, '..', 'scripts', 'ssd-tracker.js');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-tracker-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = path.join(dir, '.acuity', 'ssd-cache.json');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [TRACKER, ...args], { cwd: dir, encoding: 'utf8' });
    return { ...r, out: r.stdout + r.stderr };
  };
  const log = (round, status, primary, executor, extra = []) =>
    run('log', '--round', round, '--status', status, '--primary-ms', String(primary), '--executor-ms', String(executor), ...extra);
  const rounds = () => JSON.parse(fs.readFileSync(cache, 'utf8')).rounds;
  return { cache, run, log, rounds };
}

test('log records a round with its defaults', t => {
  const w = workspace(t);
  assert.strictEqual(w.log('r1', 'cache_hit', 120, 400, ['--reuse', '0.8', '--key', 'tests_pass']).status, 0);
  assert.strictEqual(w.log('r2', 'cache_miss', 100, 300).status, 0);
  const [hit, miss] = w.rounds();
  assert.deepStrictEqual(
    { ...hit, timestamp: undefined },
    { round_id: 'r1', timestamp: undefined, cache_status: 'cache_hit', primary_ms: 120, executor_ms: 400, reuse_ratio: 0.8, outcome_key: 'tests_pass', cache_miss_reason: 'none' },
  );
  assert.strictEqual(miss.reuse_ratio, 0);
  assert.strictEqual(miss.outcome_key, null);
  assert.strictEqual(miss.cache_miss_reason, 'unknown');
});

test('log rejects missing, unknown or malformed values without writing', t => {
  const w = workspace(t);
  const bad = [
    ['log', '--round', 'r1', '--status', 'cache_hit'],
    ['log', '--round', 'r1', '--status', 'lucky', '--primary-ms', '1', '--executor-ms', '2'],
    ['log', '--round', 'r1', '--status', 'cache_hit', '--primary-ms', 'fast', '--executor-ms', '2'],
    ['log', '--round', 'r1', '--status', 'cache_hit', '--primary-ms', '1', '--executor-ms', '-2'],
    ['log', '--round', 'r1', '--status', 'cache_hit', '--primary-ms', '1', '--executor-ms', '2', '--reuse', '7'],
    ['log', '--round', 'r1', '--status', 'cache_hit', '--primary-ms', '1', '--executor-ms', '2', '--reuse', 'most'],
  ];
  for (const args of bad) {
    const r = w.run(...args);
    assert.strictEqual(r.status, 1, `${args.join(' ')}\n${r.out}`);
  }
  assert.ok(!fs.existsSync(w.cache), 'no cache file should have been written');
});

test('an unreadable cache is reported and left untouched', t => {
  const w = workspace(t);
  fs.mkdirSync(path.dirname(w.cache));
  const corrupt = '{"rounds":[{"round_id":"r1"';
  fs.writeFileSync(w.cache, corrupt);
  const logged = w.log('r2', 'cache_miss', 5, 9);
  assert.strictEqual(logged.status, 1, logged.out);
  assert.match(logged.out, /not a valid tracker cache/);
  assert.strictEqual(w.run('stats').status, 1);
  assert.strictEqual(fs.readFileSync(w.cache, 'utf8'), corrupt);
});

test('stats with no rounds', t => {
  const r = workspace(t).run('stats');
  assert.strictEqual(r.status, 0);
  assert.match(r.out, /No speculation rounds logged yet/);
});

test('stats counts speculated rounds only and reports healthy runs', t => {
  const w = workspace(t);
  w.log('r1', 'cache_hit', 100, 400, ['--reuse', '0.9', '--key', 'a']);
  w.log('r2', 'partial_branch_reuse', 100, 400, ['--reuse', '0.4', '--key', 'b']);
  w.log('r3', 'no_speculation', 0, 400);
  const r = w.run('stats');
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /Total Logged Rounds: 3/);
  assert.match(r.out, /Speculated Rounds {2}: 2/);
  assert.match(r.out, /Hit Rate {11}: 0\.50 \(1\/2\)/);
  assert.match(r.out, /Avg Reuse Ratio {4}: 0\.65/);
  assert.match(r.out, /Est\. Time Saved {4}: 0\.10s/);
  assert.match(r.out, /performance is healthy/);
});

test('stats flags each stop rule', async t => {
  await t.test('hit rate below 0.30 over the last 5 speculated rounds', t => {
    const w = workspace(t);
    w.log('r1', 'cache_hit', 10, 400, ['--reuse', '0.9']);
    for (const id of ['r2', 'r3', 'r4', 'r5']) w.log(id, 'cache_miss', 10, 400);
    assert.match(w.run('stats').out, /hit rate is 20% < 30% over the last 5 rounds/);
  });

  await t.test('primary draft time at or above executor time for 2 rounds', t => {
    const w = workspace(t);
    w.log('r1', 'cache_hit', 500, 400, ['--reuse', '0.9']);
    w.log('r2', 'cache_hit', 400, 400, ['--reuse', '0.9']);
    assert.match(w.run('stats').out, /Primary draft latency >= executor time/);
  });

  await t.test('reuse below 0.25 on the last 2 matched-key rounds', t => {
    const w = workspace(t);
    w.log('r1', 'partial_branch_reuse', 10, 400, ['--reuse', '0.2', '--key', 'a']);
    w.log('r2', 'cache_miss', 10, 400, ['--reuse', '0.1', '--key', 'b']);
    const out = w.run('stats').out;
    assert.match(out, /Reuse ratio < 0\.25/);
    assert.match(out, /Consider disabling/);
  });
});

test('an unknown or missing command prints usage', t => {
  const w = workspace(t);
  for (const args of [[], ['frobnicate']]) {
    const r = w.run(...args);
    assert.strictEqual(r.status, 1);
    assert.match(r.out, /Usage:/);
  }
});
