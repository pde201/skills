// Offline tests for the prd-lifecycle scripts. A stub `gh` on PATH applies
// the scripts' own --jq filters to fixture JSON and logs every call, so no
// test touches GitHub. Needs git, bash and jq.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scripts = path.join(__dirname, '..', 'scripts');

const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
filter=""
prev=""
for arg in "$@"; do
  [[ "$prev" == "--jq" ]] && filter="$arg"
  prev="$arg"
done
case "$1 $2" in
  "issue list")
    [[ -n "\${LIST_FAIL:-}" ]] && exit 1
    jq -r "$filter" <<< "\${ISSUES:-[]}"
    ;;
  "issue comment")
    body=""
    prev=""
    for arg in "$@"; do
      [[ "$prev" == "--body-file" ]] && body="$arg"
      prev="$arg"
    done
    cp "$body" "$GH_LOG.body"
    ;;
  "issue close") ;;
  api*)
    [[ -n "\${SUB_FAIL:-}" ]] && exit 1
    jq -r "$filter" <<< "\${SUBS:-[]}"
    ;;
esac
`;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-lifecycle-test-'));
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  const log = path.join(root, 'gh.log');
  fs.writeFileSync(log, '');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('checkout', '-qb', 'feature/issue-12');
  fs.writeFileSync(path.join(repo, 'docs', 'walkthrough.html'), '<p>x</p>');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'echo "tests ran CI=$CI"' } }));
  git('add', '-A');
  git('commit', '-qm', 'init');
  const env = (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, ...extra });
  return {
    repo,
    log,
    git,
    ghCalls: () => fs.readFileSync(log, 'utf8'),
    run: (cmd, args, extra) => spawnSync(cmd, args, { cwd: repo, env: env(extra), encoding: 'utf8' }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function verify(box, args, extra) {
  const r = box.run('bash', [path.join(scripts, 'verify-prd-closing.sh'), ...args], extra);
  return { ...r, out: r.stdout + r.stderr };
}

test('verify-prd-closing.sh', async t => {
  const box = sandbox();
  t.after(box.cleanup);

  await t.test('passes when only #123 is open for PRD #12', () => {
    const r = verify(box, ['12'], { ISSUES: JSON.stringify([{ number: 50, body: 'Parent: #123' }]) });
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /All child issues are closed/);
  });

  await t.test('lists open children referenced in the body or linked as sub-issues', () => {
    const r = verify(box, ['#12'], {
      ISSUES: JSON.stringify([{ number: 51, body: 'Parent: #12.' }, { number: 12, body: 'the PRD mentions #12' }]),
      SUBS: JSON.stringify([{ number: 77, state: 'open' }, { number: 78, state: 'closed' }]),
    });
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /#51/);
    assert.match(r.out, /#77/);
    assert.doesNotMatch(r.out, /#78|   #12\b/);
  });

  await t.test('asks gh for more than its default 30 issues', () => {
    assert.match(box.ghCalls(), /issue list .*--limit 1000/);
  });

  await t.test('falls back to body references when the sub-issues API fails', () => {
    const r = verify(box, ['12'], { SUB_FAIL: '1' });
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /Sub-issues API unavailable/);
  });

  await t.test('stops when gh cannot list issues', () => {
    const r = verify(box, ['12'], { LIST_FAIL: '1' });
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /could not list issues/);
  });

  await t.test('rejects a non-numeric PRD number', () => {
    assert.strictEqual(verify(box, ['abc']).status, 2);
    assert.strictEqual(verify(box, []).status, 2);
  });

  await t.test('requires the walkthrough HTML', () => {
    const r = verify(box, ['12', '--html', 'docs/missing.html']);
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /docs\/missing\.html is missing/);
  });

  await t.test('fails on uncommitted files other than the walkthrough', () => {
    fs.writeFileSync(path.join(box.repo, 'stray.txt'), 'x');
    fs.writeFileSync(path.join(box.repo, 'walkthrough.md'), 'x');
    const r = verify(box, ['12']);
    fs.rmSync(path.join(box.repo, 'stray.txt'));
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /stray\.txt/);
    assert.doesNotMatch(r.out, /\?\? walkthrough\.md/);
  });

  await t.test('detects npm test and runs it once with CI=true', () => {
    const r = verify(box, ['12']);
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /Running test: npm test/);
    assert.match(r.out, /tests ran CI=true/);
    assert.match(r.out, /no typecheck command detected/);
  });

  await t.test('uses given commands and fails when one fails', () => {
    const r = verify(box, ['12', '--typecheck', 'exit 3', '--test', 'none']);
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /typecheck failed/);
    assert.doesNotMatch(r.out, /Running test/);
  });

  await t.test('runs checks from --dir', () => {
    fs.mkdirSync(path.join(box.repo, 'app'), { recursive: true });
    const r = verify(box, ['12', '--dir', 'app', '--typecheck', 'pwd']);
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /\/app\n/);
    assert.strictEqual(verify(box, ['12', '--dir', 'nope']).status, 1);
  });

  await t.test('warns when the branch names a different issue', () => {
    box.git('checkout', '-qb', 'feature/issue-123');
    const r = verify(box, ['12', '--test', 'none']);
    box.git('checkout', '-q', 'feature/issue-12');
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /does not reference PRD #12/);
  });
});

test('post-walkthrough.js', async t => {
  const box = sandbox();
  t.after(box.cleanup);
  fs.writeFileSync(path.join(box.repo, 'walkthrough.md'), '# Done\n');
  const post = args => box.run(process.execPath, [path.join(scripts, 'post-walkthrough.js'), ...args]);

  await t.test('rejects an issue argument that is not a number', () => {
    const r = post(['12; touch pwned', 'walkthrough.md']);
    assert.strictEqual(r.status, 2);
    assert.strictEqual(box.ghCalls(), '');
    assert.ok(!fs.existsSync(path.join(box.repo, 'pwned')));
  });

  await t.test('posts the comment and leaves the PRD open by default', () => {
    const r = post(['12', 'walkthrough.md']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(box.ghCalls(), /^issue comment 12 --body-file /m);
    assert.doesNotMatch(box.ghCalls(), /issue close/);
    assert.strictEqual(fs.readFileSync(`${box.log}.body`, 'utf8'), '> *This was generated by AI during triage.*\n\n# Done\n');
  });

  await t.test('closes the PRD only with --close', () => {
    const r = post(['#12', 'walkthrough.md', '--close']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(box.ghCalls(), /^issue close 12$/m);
  });

  await t.test('leaves no temporary file in the repository', () => {
    const status = box.git('status', '--porcelain').stdout;
    assert.doesNotMatch(status, /temp-comment/);
  });
});

test('generate-walkthrough.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-walkthrough-test-'));
  try {
    const md = path.join(dir, 'w.md');
    const out = path.join(dir, 'nested', 'docs', 'w.html');
    fs.writeFileSync(md, [
      '# PRD #12 `walkthrough`',
      '',
      '- one',
      '- two',
      '',
      '## Middle',
      '',
      '```bash',
      '# a comment, not a heading',
      '<b>raw</b> **not bold**',
      '```',
      '',
      '---',
      '',
      '1. first',
      '2. second',
      '',
      'See [the issue](https://example.com/12) and [bad](javascript:alert(1)).',
      '',
    ].join('\n'));
    const r = spawnSync(process.execPath, [path.join(scripts, 'generate-walkthrough.js'), md, out], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const html = fs.readFileSync(out, 'utf8');
    assert.match(html, /<title>PRD #12 walkthrough<\/title>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>\n<h2>Middle<\/h2>/);
    assert.match(html, /<pre><code># a comment, not a heading\n&lt;b&gt;raw&lt;\/b&gt; \*\*not bold\*\*<\/code><\/pre>/);
    assert.match(html, /<hr>/);
    assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(html, /<a href="https:\/\/example\.com\/12">the issue<\/a>/);
    assert.doesNotMatch(html, /href="javascript:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
