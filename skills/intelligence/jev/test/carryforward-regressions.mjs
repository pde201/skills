import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'jev-carry-regression-'));
process.env.JEV_STATE_DIR = join(root, 'state');
process.env.JEV_HOOKS_CARRY_FORWARD = '1';
process.env.JEV_RETRIES = '0';
delete process.env.TYPESAFE_API_KEY;
const { harvest, composeBrief, buildBrief, consumeBrief } = await import('../lib/carryforward.mjs');
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
function transcript(entries) {
  const path = join(root, `transcript-${count++}.jsonl`);
  writeFileSync(path, entries.map(message => JSON.stringify({ message })).join('\n'));
  return path;
}
const user = content => ({ role: 'user', content });

test('long and tagged user requirements remain complete, including short corrections', () => {
  const long = 'Background '.repeat(100) + '\nNever deploy to production.';
  const path = transcript([user(long), user([{ type: 'text', text: '<request>Keep the public API unchanged.</request>' }]), user('Stop.')]);
  const candidates = harvest(path);
  assert.equal(candidates[0].text, long);
  assert.equal(candidates[1].text, '<request>Keep the public API unchanged.</request>');
  assert.equal(candidates[2].text, 'Stop.');
  const brief = composeBrief(candidates, new Set(), {}, 'Stop.');
  assert.ok(brief.includes(long));
});

test('repeated and corrected requirements preserve transcript order and provenance', () => {
  const path = transcript([user('Use staging.'), user('Correction: use development.'), user('Use staging.')]);
  const requests = harvest(path);
  assert.deepEqual(requests.map(c => c.text), ['Use staging.', 'Correction: use development.', 'Use staging.']);
  assert.deepEqual(requests.map(c => c.sourceEntry), [1, 2, 3]);
  const brief = composeBrief(requests, new Set(), {}, 'Use staging.');
  assert.ok(brief.indexOf('[transcript entry 1]') < brief.indexOf('[transcript entry 2]'));
  assert.ok(brief.indexOf('[transcript entry 2]') < brief.indexOf('[transcript entry 3]'));
  assert.match(brief, /later corrections supersede/);
});

test('past failure followed by completion is evidence, not an asserted pending task', () => {
  const path = transcript([
    user('Run the build.'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'build', name: 'Bash', input: { command: 'npm run build' } }] },
    user([{ type: 'tool_result', tool_use_id: 'build', is_error: true, content: 'Build failed.' }]),
    user('The build is fixed and verified. That work is complete; move on.'),
  ]);
  const brief = composeBrief(harvest(path), new Set(), {}, 'Continue.');
  assert.ok(brief.includes('That work is complete; move on.'));
  assert.match(brief, /Historical failures/);
  assert.doesNotMatch(brief, /## Unresolved failures|Work was left unfinished/);
  assert.match(brief, /Completed or explicitly abandoned work is not pending/);
});

test('mandatory history exceeding the limit does not retain every optional action', () => {
  const entries = Array.from({ length: 45 }, (_, i) => user(`Requirement ${i}: keep this instruction.`));
  for (let i = 0; i < 10; i++) {
    entries.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } }] });
    entries.push(user([{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }]));
  }
  const candidates = harvest(transcript(entries));
  assert.equal(candidates.filter(c => c.kind === 'request').length, 45);
  assert.equal(candidates.filter(c => !c.mandatory).length, 0);
});

test('briefs use private files and safe session names, and are consumed once per session', async () => {
  const path = transcript([user('Preserve this requirement in the next session.')]);
  const first = await buildBrief({ transcriptPath: path, sessionId: '../../outside' });
  const second = await buildBrief({ transcriptPath: path, sessionId: 'other' });
  assert.equal(dirname(first.path), process.env.JEV_STATE_DIR);
  assert.notEqual(first.path, second.path);
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.ok(consumeBrief('../../outside').includes('Preserve this requirement'));
  assert.equal(consumeBrief('../../outside'), null);
  assert.ok(consumeBrief('other'));
});

test('remote ranking is bounded while all full requirements remain locally recoverable', async () => {
  const path = transcript(Array.from({ length: 60 }, (_, i) => user(`Requirement ${i}: ` + 'long context '.repeat(500) + ` tail-${i}`)));
  const originalFetch = globalThis.fetch;
  let payload;
  process.env.TYPESAFE_API_KEY = 'synthetic-test-key';
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    const result = await buildBrief({ transcriptPath: path, sessionId: 'bounded' });
    assert.ok(payload.state.candidates.length <= 40);
    assert.ok(JSON.stringify(payload.state).length < 50000);
    const brief = readFileSync(result.path, 'utf8');
    for (let i = 0; i < 60; i++) assert.ok(brief.includes(`tail-${i}`));
    assert.ok(brief.includes('long context '.repeat(500)));
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    globalThis.fetch = originalFetch;
  }
});
