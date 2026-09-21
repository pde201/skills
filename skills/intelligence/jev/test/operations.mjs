import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-operations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function environment(dir) {
  const env = { ...process.env, JEV_STATE_DIR: join(dir, 'state'), JEV_HOOKS: '1',
    JEV_HOOKS_SLIM: '1', JEV_HOOKS_GUARD: '1', JEV_HOOKS_CARRY_FORWARD: '1',
    JEV_CODEX_SLIM_ALLOW: '0', JEV_ANTIGRAVITY_EXPLICIT_ALLOW: '0' };
  delete env.TYPESAFE_API_KEY;
  delete env.JEV_LOG;
  return env;
}
for (const [agent, variable] of [['claude', 'CLAUDE_SETTINGS'], ['codex', 'CODEX_HOOKS'], ['antigravity', 'JEV_ANTIGRAVITY_HOOKS']]) {
  test(`${agent}: checking missing registration creates no files`, t => {
    const dir = isolated(t);
    const config = join(dir, 'missing', 'hooks.json');
    execFileSync('bash', [join(root, 'install.sh'), agent, '--check'], {
      env: { ...environment(dir), [variable]: config },
    });
    assert.deepEqual(readdirSync(dir), []);
  });
  test(`${agent}: checking existing registration preserves exact configuration`, t => {
    const dir = isolated(t);
    const config = join(dir, 'hooks.json');
    const original = '{ "unrelated": { "enabled": true }, "hooks": {} }\n';
    writeFileSync(config, original);
    execFileSync('bash', [join(root, 'install.sh'), agent, '--check'], {
      env: { ...environment(dir), [variable]: config },
    });
    assert.equal(readFileSync(config, 'utf8'), original);
    assert.deepEqual(readdirSync(dir), ['hooks.json']);
  });
}

test('missing key retains local rewrite and deterministic restriction, never grants approval', t => {
  const dir = isolated(t);
  for (const [command, expected] of [['npm test', 'rewrite'], ['rm -rf /', 'ask']]) {
    const output = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/jev-hook.mjs')], {
      env: environment(dir), input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    }));
    const decision = output.hookSpecificOutput;
    if (expected === 'ask') assert.equal(decision.permissionDecision, 'ask');
    else assert.ok(decision.updatedInput.command.includes('jev-slim.mjs'));
    assert.notEqual(decision.permissionDecision, 'allow');
  }
});

for (const installer of ['node', 'shell']) {
  test(`${installer} packaging includes reachable skill references and evals`, t => {
    const dir = isolated(t);
    const executable = installer === 'node' ? process.execPath : 'bash';
    const script = installer === 'node' ? 'bin/install.js' : 'install-skill.sh';
    execFileSync(executable, [join(root, script), '--dest', dir], { env: environment(dir) });
    const installed = join(dir, 'jev');
    for (const relative of ['SKILL.md', 'package.json', 'references/integrations.md', 'references/data-handling.md', 'evals/README.md', 'lib/client.mjs']) {
      assert.ok(existsSync(join(installed, relative)), relative);
    }
    const skill = readFileSync(join(installed, 'SKILL.md'), 'utf8');
    for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(existsSync(resolve(installed, match[1])), `Broken packaged reference: ${match[1]}`);
    }
  });
}


test('Codex prompt stash is private, complete, session-isolated, and cleaned on end', t => {
  const dir = isolated(t);
  const env = environment(dir);
  const adapter = join(root, 'bin/jev-hook-codex.mjs');
  const invoke = event => execFileSync(process.execPath, [adapter], { env, input: JSON.stringify(event) });
  const prompt = 'Context '.repeat(600) + 'Never deploy to production.';
  invoke({ hook_event_name: 'UserPromptSubmit', session_id: '../../outside', prompt });
  invoke({ hook_event_name: 'UserPromptSubmit', session_id: 'other', prompt: 'Other task' });
  const state = join(dir, 'state');
  const files = readdirSync(state).filter(name => name.startsWith('codex-prompt-'));
  assert.equal(files.length, 2);
  const contents = files.map(name => {
    const path = join(state, name);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    return readFileSync(path, 'utf8');
  });
  assert.ok(contents.includes(prompt));
  assert.ok(contents.includes('Other task'));
  invoke({ hook_event_name: 'SessionEnd', session_id: '../../outside' });
  const remaining = readdirSync(state).filter(name => name.startsWith('codex-prompt-'));
  assert.equal(remaining.length, 1);
  assert.equal(readFileSync(join(state, remaining[0]), 'utf8'), 'Other task');
});
