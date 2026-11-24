const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { until, withHome } = require('@lengmoxxl/wangcai-testkit');

// What a case does to the window's own chrome.
//
// The menu that makes a workspace is the space under the rows: the rows have to end above the list's bottom edge, so the
// click lands on the list rather than on a row.
const openWorkspaceMenu = async (page) => {
  const list = page.locator('.workspaces');
  const box = await list.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 4, { button: 'right' });
};

/** The terminal of the workspace in front: the app's own pane, not a plugin's panel. */
const activeTerminal = (page) => page.locator('.terminal-pane.active');

/** Types a line into the pane in front and runs it, the way a person does. */
const run = async (page, line) => {
  await activeTerminal(page).locator('.xterm-helper-textarea').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

/** Waits until the terminal in front draws that text, which it does once the shell has written it. */
const terminalShows = (page, text) => activeTerminal(page).locator('.xterm-screen').filter({ hasText: text }).waitFor();

/** Opens a local workspace, and waits for the shell its pane draws a moment after the workspace appears. */
const createWorkspace = async (page) => {
  await openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await terminalShows(page, /\S/);
};

/** Opens a view in the sidebar, showing the sidebar first when it is off screen. */
const openView = async (page, name) => {
  const newTab = page.getByRole('button', { name: '新建侧栏标签页' });
  if (!(await newTab.isVisible())) await page.getByRole('button', { name: '切换右侧栏' }).click();
  await newTab.click();
  await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
};

const directory = resolve(__dirname, '..');
const caseTimeout = 180000;
// The page reads the repository by itself every pollMilliseconds (ui.tsx), so a window meant to outlast one read is a
// poll plus what that case needs.
const poll = 3000;

// The file click the rail publishes when it opens a comparison, caught on the page instead of in a view of its own.
const catchClicks = (page) => page.evaluate(() => {
  window.__clicks = [];
  window.wangcai.subscribe('onclick', (file) => window.__clicks.push(file));
});
const lastClick = (page) => page.evaluate(() => window.__clicks.at(-1));

const gitFile = '.git-file';
const gitRail = (page) => page.locator('.git-rail');
const railFiles = (page) => gitRail(page).locator(gitFile);
const sectionFiles = (page, name) => gitRail(page).locator('details').filter({ has: page.locator('summary', { hasText: new RegExp(`^${name}`) }) }).locator(gitFile);
const commitFiles = (page) => gitRail(page).locator(`.git-commit-files ${gitFile}`);
const commitRows = (page) => gitRail(page).locator('.git-commit-row');
const heldKey = (page) => gitRail(page).locator('[data-cursor]').getAttribute('data-row');
const refreshGit = (page) => page.getByRole('button', { name: '刷新 Git' });
const noTerminal = (page) => page.getByText('请选择一个已连接的终端', { exact: true });
const mainBranch = (page) => page.locator('.git-branch').filter({ hasText: 'main' });

// Points the terminal at a repository and has the page read it.
const readRepo = async (page, repo, shows) => {
  await run(page, `cd '${repo.replaceAll("'", "'\\''")}'`);
  await terminalShows(page, shows);
  await refreshGit(page).click();
  await mainBranch(page).waitFor();
};

// A repository of this case's own, with a committer to write as.
const repoIn = (home, env, name) => {
  const repo = join(home, name);
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'UI Test');
  git('config', 'user.email', 'ui@test.local');
  return { repo, git };
};

const gitTab = { id: 'git', directory };
const gitLists = { workspaces: ['terminal-agent'], tabs: [gitTab] };
const gitListsNoAutoRefresh = { workspaces: ['terminal-agent'], tabs: [{ ...gitTab, config: { autoRefresh: false } }] };

// One case with the Git view open, a local workspace it follows, and no error on the page by the end.
const withGitApp = (prefix, lists, body) => withHome(prefix, lists, async ({ home, env, open }) => {
  const { page } = await open();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await openView(page, 'Git');
  await noTerminal(page).waitFor();
  await createWorkspace(page);
  await body({ home, env, page });
  assert.deepEqual(errors, []);
});

test('Git history loads the next page when the rail is scrolled to its end', { timeout: caseTimeout }, () => withGitApp('wangcai-git-page',
  gitLists,
  async ({ home, env, page }) => {
    // More commits than the 50 the first page holds, so the rail has a second page to reach.
    const total = 55;
    const { repo, git } = repoIn(home, env, 'paging');
    for (let commit = 0; commit < total; commit++) {
      writeFileSync(join(repo, 'count.txt'), `${commit}\n`);
      git('add', 'count.txt'); git('commit', '-qm', `commit ${commit}`);
    }
    await readRepo(page, repo, 'paging');
    assert.equal(await commitRows(page).count(), 50, 'the first page stops at 50 commits');
    const railBox = await gitRail(page).boundingBox();
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2);
    // Only the wheel touches the rail from here on: reaching its end is what fetches the second page.
    await until(async () => (await commitRows(page).count()) === total, { act: () => page.mouse.wheel(0, 400) });
    assert.match(await commitRows(page).last().textContent(), /commit 0/, 'the appended page keeps the history order');
  }));

test('With auto refresh off, the Git page reads the repository only when asked', { timeout: caseTimeout }, () => withGitApp('wangcai-git-off',
  gitListsNoAutoRefresh,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'repo');
    writeFileSync(join(repo, 'tracked.ts'), 'const tracked = true;\n');
    git('add', 'tracked.ts'); git('commit', '-qm', 'initial commit');
    await run(page, `cd '${repo}'`);
    await terminalShows(page, 'repo');
    await mainBranch(page).waitFor();
    // The shell's cd reaches the page as the workspace's rename, a tick of the core's renamer after the branch read:
    // let that read land too, so the page is idle from here until a read is asked for.
    await page.waitForTimeout(1500);
    writeFileSync(join(repo, 'asked.ts'), 'const asked = true;\n');
    git('add', 'asked.ts');
    await refreshGit(page).click();
    await railFiles(page).filter({ hasText: 'asked.ts' }).waitFor();
    writeFileSync(join(repo, 'fresh.ts'), 'const fresh = true;\n');
    // A page that read on its own would bring the file to the rail inside this window.
    await page.waitForTimeout(poll + 2000);
    assert.equal(await railFiles(page).filter({ hasText: 'fresh.ts' }).count(), 0, 'the page reads the repository only when asked');
    await refreshGit(page).click();
    await railFiles(page).filter({ hasText: 'fresh.ts' }).waitFor();
  }));

test('The rail answers hjkl, folds sections and toggles commits', { timeout: caseTimeout }, () => withGitApp('wangcai-git-keys',
  gitLists,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'repo');
    writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
    git('add', '.'); git('commit', '-qm', 'initial commit');
    writeFileSync(join(repo, 'a.ts'), 'const a = 2;\n');
    writeFileSync(join(repo, 'b.ts'), 'const b = 1;\n');
    await readRepo(page, repo, 'repo');
    const closedSections = () => gitRail(page).locator('details:not([open])');
    // The keys belong to the panel: a row with the focus is enough for the first press, which enters at the top.
    await railFiles(page).first().focus();
    await page.keyboard.press('k');
    assert.equal(await heldKey(page), 'stage:unstaged', 'the first k enters the list at its top');
    await page.keyboard.press('h');
    assert.equal(await closedSections().count(), 1, 'h folds the section around the cursor');
    assert.equal(await railFiles(page).first().isVisible(), false, 'a folded section draws no row');
    await page.keyboard.press('l');
    assert.equal(await closedSections().count(), 0, 'l unfolds it again');
    await page.keyboard.press('j');
    assert.equal(await heldKey(page), 'change:unstaged:a.ts', 'j walks down into the section');
    // A commit row toggles its files where it stands, and h on one of those files closes the commit it hangs under.
    await page.keyboard.press('G');
    // The last row is a commit's file when its commit stands open; h closes that and leaves the keys on the commit row.
    await page.keyboard.press('h');
    assert.match(await heldKey(page), /^commit:/, 'G lands on the last commit row');
    await page.keyboard.press('l');
    await commitFiles(page).first().waitFor();
    await page.keyboard.press('j');
    assert.match(await heldKey(page), /^commitfile:/, 'j walks into the commit files');
    await page.keyboard.press('h');
    await commitFiles(page).first().waitFor({ state: 'detached' });
    assert.match(await heldKey(page), /^commit:/, 'h on a file closes the commit and leaves the keys on its row');
  }));

test('Choosing a file publishes the comparison as a git:// click for the editor', { timeout: caseTimeout }, () => withGitApp('wangcai-git-click',
  gitLists,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'repo');
    const file = join(repo, 'app.ts');
    writeFileSync(file, 'const a = 1;\n');
    git('add', '.'); git('commit', '-qm', 'initial commit');
    writeFileSync(file, 'const a = 2;\n');
    git('add', 'app.ts');
    writeFileSync(file, 'const a = 3;\n');
    writeFileSync(join(repo, 'new.ts'), 'const n = 1;\n');
    await readRepo(page, repo, 'repo');
    await catchClicks(page);
    // The unstaged side reads the index against the worktree; the staged side reads HEAD against the index.
    await sectionFiles(page, '未暂存').filter({ hasText: 'app.ts' }).click();
    await until(async () => (await lastClick(page))?.path.endsWith('app.ts@:index~:worktree'));
    assert.equal((await lastClick(page)).type, 'file');
    await sectionFiles(page, '已暂存').filter({ hasText: 'app.ts' }).click();
    await until(async () => (await lastClick(page))?.path.endsWith('app.ts@HEAD~:index'));
    // An untracked file has no old side, so its base is the empty token.
    await sectionFiles(page, '未跟踪').filter({ hasText: 'new.ts' }).click();
    await until(async () => (await lastClick(page))?.path.endsWith('new.ts@:empty~:worktree'));
  }));

test('Ctrl+Shift+h slides a hidden list out, and choosing a file slides it back', { timeout: caseTimeout }, () => withGitApp('wangcai-git-peek',
  gitLists,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'repo');
    writeFileSync(join(repo, 'peek.ts'), 'const a = 1;\n');
    git('add', '.'); git('commit', '-qm', 'initial commit');
    writeFileSync(join(repo, 'peek.ts'), 'const a = 2;\n');
    await readRepo(page, repo, 'repo');
    await catchClicks(page);
    await page.getByRole('button', { name: '切换 Git 列表' }).click();
    assert.equal(await gitRail(page).isVisible(), false, 'the toolbar toggle hides the list');
    await page.keyboard.press('Control+Shift+H');
    await until(() => gitRail(page).isVisible());
    await until(async () => (await heldKey(page)) === 'stage:unstaged');
    await page.keyboard.press('j');
    assert.equal(await heldKey(page), 'change:unstaged:peek.ts', 'the keys walk the list the press slid out');
    await page.keyboard.press('l');
    await until(async () => (await lastClick(page))?.path.endsWith('peek.ts@:index~:worktree'));
    assert.equal(await gitRail(page).isVisible(), false, 'the file the keys chose slides the list away again');
  }));

test('A Git tab that opens again draws the layout the last one was left at', { timeout: caseTimeout }, () => withGitApp('wangcai-git-layout',
  gitLists,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'layout');
    writeFileSync(join(repo, 'note.txt'), 'one\n');
    git('add', '.'); git('commit', '-qm', 'initial commit');
    writeFileSync(join(repo, 'note.txt'), 'two\n');
    await readRepo(page, repo, 'layout');
    const divider = page.locator('.git-divider');
    await divider.focus();
    await page.keyboard.press('ArrowRight');
    await gitRail(page).locator('summary', { hasText: '未暂存' }).click();
    const railWidth = () => gitRail(page).evaluate((rail) => Math.round(rail.getBoundingClientRect().width));
    assert.equal(await railWidth(), 280, 'the divider steps the list 20px wider');
    // The layout is written for the window rather than for the tab that changed it, so the tab that opens next reads it.
    await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('git-layout'))?.folded ?? [])).includes('unstaged'));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('git-layout'))),
      { railShown: true, railWidth: 280, folded: ['unstaged'] });
    await page.locator('.sidebar-tab:has([aria-selected=true]) .close-tab').click();
    await openView(page, 'Git');
    await mainBranch(page).waitFor();
    assert.equal(await railWidth(), 280, 'the width is the one the last tab was left at');
    assert.equal(await gitRail(page).locator('details[data-stage=unstaged]').evaluate((details) => details.open), false, 'the section folded before stays folded');
  }));
