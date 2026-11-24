const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { until, withHome } = require('@lengmoxxl/wangcai-testkit');

// The two plugins the comparison crosses: the Git list that names it, and the editor that reads it.
const lists = {
  workspaces: ['terminal-agent'],
  tabs: [{ id: 'git', directory: resolve(__dirname, '..') }, { id: 'editor', directory: resolve(__dirname, '../../WangCai-editor') }],
};

const activeTerminal = (page) => page.locator('.terminal-pane.active');
const run = async (page, line) => {
  await activeTerminal(page).locator('.xterm-helper-textarea').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};
const terminalShows = (page, text) => activeTerminal(page).locator('.xterm-screen').filter({ hasText: text }).waitFor();
const openView = async (page, name) => {
  const newTab = page.getByRole('button', { name: '新建侧栏标签页' });
  if (!(await newTab.isVisible())) await page.getByRole('button', { name: '切换右侧栏' }).click();
  await newTab.click();
  await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
};
const createWorkspace = async (page) => {
  const list = page.locator('.workspaces');
  const box = await list.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 4, { button: 'right' });
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await terminalShows(page, /\S/);
};

const diffHost = '.editor-diff .git-editor';
const lineShown = (page, side, text) => until(() => page.locator(`${diffHost} ${side} .cm-line`).filter({ hasText: text }).count().then(n => n > 0));

test('a file chosen in the Git list opens its comparison in the editor', { timeout: 180000 }, () => withHome('wangcai-git-editor', lists, async ({ home, env, open }) => {
  const { page } = await open();
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Demo'); git('config', 'user.email', 'demo@local');
  const file = join(repo, 'app.ts');
  writeFileSync(file, "const greet = 'hi';\n");
  git('add', '.'); git('commit', '-qm', 'initial');
  writeFileSync(file, "const greet = 'hello';\n");

  await openView(page, 'Git');
  await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
  await createWorkspace(page);
  await run(page, `cd '${repo}'`);
  await terminalShows(page, 'repo');
  await page.getByRole('button', { name: '刷新 Git' }).click();
  await page.locator('.git-branch').filter({ hasText: 'main' }).waitFor();

  // Choosing the unstaged file hands the comparison to the editor, which draws both sides of it.
  await page.locator('.git-rail details').filter({ has: page.locator('summary', { hasText: /^未暂存/ }) }).locator('.git-file').first().click();
  const gear = page.getByRole('button', { name: '差异设置' });
  await gear.click();
  const reading = page.locator('.code-menu button').filter({ hasText: /^阅读方式/ });
  for (let at = 0; at < 3 && (await reading.innerText()) !== '阅读方式：双栏'; at += 1) await reading.click();
  await page.keyboard.press('Escape');
  await lineShown(page, '.cm-merge-a', "const greet = 'hi';");
  await lineShown(page, '.cm-merge-b', "const greet = 'hello';");
  assert.ok(await page.locator('.editor-diff').isVisible(), 'the editor shows the comparison');
}));
