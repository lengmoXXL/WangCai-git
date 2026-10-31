const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync, statSync, copyFileSync, utimesSync, renameSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { closeView, createWorkspace, openView, run, terminalShows, until, viewTabs, withWindow } = require('@lengmoxxl/wangcai-testkit');

const directory = resolve(__dirname, '..');
const caseTimeout = 180000;
// The page reads the repository by itself every pollMilliseconds (ui.tsx), so a window meant to outlast one read is a
// poll plus what that case needs.
const poll = 3000;

const filesPanel = '.sidebar-panel[data-plugin=files]';
const gitRail = (page) => page.locator('.git-rail');
const railFiles = (page) => gitRail(page).locator('.git-file');
const sectionFiles = (page, name) => gitRail(page).locator('details').filter({ has: page.locator('summary', { hasText: new RegExp(`^${name}`) }) }).locator('.git-file');
const commitFiles = (page) => page.locator('.git-commit-files .git-file');
const commitRows = (page) => page.locator('.git-commit-row');
const diffEditor = (page, variant = '') => page.locator(`.git-editor .monaco-diff-editor${variant}`);
const diffLines = (page) => page.locator('.git-editor .view-lines');
const modifiedLines = (page) => page.locator('.git-editor .editor.modified .view-lines');
const originalLines = (page) => page.locator('.git-editor .editor.original .view-lines');
const readingPage = (page, mode) => page.locator(`.git-page[data-reading=${mode}]`);
const statusMark = (page, mark) => page.locator(`.git-status-${mark}`);
const refreshGit = (page) => page.getByRole('button', { name: '刷新 Git' });
const openFile = (page) => page.getByRole('button', { name: '打开文件', exact: true });
const noTerminal = (page) => page.getByText('请选择一个已连接的终端', { exact: true });
const noFile = (page) => page.getByText('选择文件查看 diff', { exact: true });
const notARepository = (page) => page.locator('.git-note[role=alert]').filter({ hasText: 'not a git repository' });
const mainBranch = (page) => page.locator('.git-branch').filter({ hasText: 'main' });

// Points the terminal at a repository and has the page read it. `shows` is the text the terminal draws once the shell
// is in that directory, which the caller knows and this helper does not.
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
const gitListsWithFiles = { workspaces: ['terminal-agent'], tabs: ['files', gitTab] };
const gitListsNoAutoRefresh = { workspaces: ['terminal-agent'], tabs: [{ ...gitTab, config: { autoRefresh: false } }] };

// One case with the Git view open, a local workspace it follows, and no error on the page by the end.
const withGitApp = (prefix, lists, body) => withWindow(prefix, lists, async (context) => {
  const { page, errors } = context;
  await openView(page, 'Git');
  await noTerminal(page).waitFor();
  await createWorkspace(page);
  await body(context);
  assert.deepEqual(errors, []);
});

// These checks need the same repository and the same window, so they share one case.
test('A Git tab follows the terminal, opens files from every list, and shows one read-only diff with its rail card', { timeout: caseTimeout }, () => withGitApp('wangcai-git-ui',
  // Opening a file hands it to the `files` view, so that plugin is listed beside this one.
  gitListsWithFiles,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, "repo with 'quote");
    const sample = join(repo, 'sample.ts');
    const unchanged = Array.from({ length: 20 }, (_, index) => `const unchanged${index} = ${index};\n`).join('');
    writeFileSync(sample, unchanged + 'const value = "ORIGINAL_VALUE";\n');
    git('add', '.'); git('commit', '-qm', 'initial UI commit');
    writeFileSync(sample, unchanged + 'const value = "STAGED_VALUE";\n'); git('add', '.');
    writeFileSync(sample, unchanged + 'const value = "WORKTREE_VALUE";\n');
    await notARepository(page).waitFor();
    await readRepo(page, repo, 'repo with');
    const rail = gitRail(page);
    const railShape = await rail.evaluate((element) => {
      const summaries = [...element.querySelectorAll('summary')];
      const gap = element.querySelector('.git-gap');
      return {
        titles: summaries.map((node) => node.textContent.trim()),
        arrows: summaries.map((node) => getComputedStyle(node, '::before').content),
        parts: [...element.children].map((node) => node.className || node.tagName.toLowerCase()),
        divider: [Math.round(gap.getBoundingClientRect().height), getComputedStyle(gap).flexShrink],
      };
    });
    assert.deepEqual(railShape.titles, ['已暂存 1', '未暂存 1'], 'the files are listed without a 改动 or 提交历史 title');
    assert.deepEqual(railShape.arrows, ['"▾"', '"▾"'], 'every file group carries its triangle');
    assert.deepEqual(railShape.parts, ['details', 'details', 'git-gap', 'git-history'], 'the divider sits between the files and the commits');
    assert.deepEqual(railShape.divider, [1, '0'], 'the divider never shrinks away');
    assert.ok(await openFile(page).isDisabled(), 'opening a file requires a selection');
    for (const files of [sectionFiles(page, '已暂存'), sectionFiles(page, '未暂存'), commitFiles(page)]) {
      const firstRow = files.first();
      await firstRow.hover();
      assert.ok(await firstRow.evaluate((element) => {
        const row = element.getBoundingClientRect();
        const group = element.parentElement.getBoundingClientRect();
        return row.left === group.left && row.right === group.right;
      }), 'file hover fills the entire row in every file list');
    }
    await sectionFiles(page, '已暂存').first().click();
    await diffLines(page).filter({ hasText: 'STAGED_VALUE' }).waitFor();
    // Monaco swaps the rendered lines as the diff changes, so read the font until a live one reports it.
    let font;
    await until(async () => (font = await diffLines(page).first().evaluate((element) => {
      const { fontSize, fontFamily } = getComputedStyle(element);
      return { fontSize, fontFamily };
    })).fontSize !== '');
    assert.equal(font.fontSize, '12px');
    assert.match(font.fontFamily, /^"DejaVuSansM Nerd Font Mono"/);
    assert.ok(await openFile(page).isEnabled());
    await openFile(page).click();
    const filePreview = page.locator(`${filesPanel}:visible`);
    const previewLines = filePreview.locator('.code-preview .view-lines');
    const previewPath = filePreview.locator('.preview-path');
    await previewLines.filter({ hasText: 'WORKTREE_VALUE' }).waitFor();
    assert.equal(await previewPath.getAttribute('title'), sample);
    await closeView(page);
    await sectionFiles(page, '未暂存').first().click();
    await modifiedLines(page).filter({ hasText: 'WORKTREE_VALUE' }).waitFor();
    await diffEditor(page).first().evaluate((element) => { element.dataset.kept = 'yes'; });
    // The window holds at least one read of the repository with nothing changed in it.
    await page.waitForTimeout(poll + 1500);
    assert.equal(await diffEditor(page, '[data-kept=yes]').count(), 1, 'an unchanged read does not rebuild the diff');
    const diffPane = page.locator('.git-pane');
    assert.equal(await diffPane.count(), 1);
    assert.equal(await readingPage(page, 'auto').count(), 1);
    const readingButton = page.getByRole('button', { name: /^阅读方式/ });
    await readingButton.click();
    assert.equal(await readingPage(page, 'split').count(), 1);
    assert.equal(await page.getByRole('button', { name: '阅读方式 双栏' }).count(), 1);
    await diffEditor(page, '.side-by-side').waitFor();
    const unfold = page.locator('.git-editor .codicon-unfold:visible').first();
    const iconFont = await unfold.evaluate(async (element) => {
      const style = getComputedStyle(element, '::before');
      const faces = await document.fonts.load('16px codicon', style.content.slice(1, -1));
      return { family: style.fontFamily, loaded: faces.length > 0 };
    });
    assert.equal(iconFont.family, 'codicon', 'the expand icon uses the icon font, not the code font');
    assert.ok(iconFont.loaded, 'the expand icon font is bundled and loads successfully');
    await unfold.click();
    await unfold.waitFor({ state: 'hidden' });
    await page.locator('.git-editor .editor.original .fold-unchanged:visible').first().click();
    await unfold.waitFor();
    await readingButton.click();
    assert.equal(await readingPage(page, 'inline').count(), 1);
    await diffEditor(page, ':not(.side-by-side)').waitFor();
    const wrap = page.getByRole('button', { name: '长行折行' });
    assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
    await wrap.click();
    assert.equal(await wrap.getAttribute('aria-pressed'), 'false');
    const divider = page.locator('.git-divider');
    const railWidth = () => rail.evaluate((element) => element.getBoundingClientRect().width);
    const railWidthBefore = await railWidth();
    assert.equal(Math.round(railWidthBefore), 260);
    const bodyPane = page.locator('.git-body');
    const bodyBox = await bodyPane.boundingBox();
    const dividerBox = await divider.boundingBox();
    const centre = { x: dividerBox.x + dividerBox.width / 2, y: dividerBox.y + dividerBox.height / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 30, centre.y);
    assert.equal(Math.round(await railWidth() - railWidthBefore), 30);
    await page.mouse.move(centre.x + 2000, centre.y);
    await page.mouse.up();
    assert.equal(Math.round(await railWidth()), Math.round(bodyBox.width * 0.7));
    await divider.hover();
    assert.equal(await divider.evaluate((element) => getComputedStyle(element, '::before').backgroundColor), 'rgb(57, 148, 188)');
    const railToggle = page.getByRole('button', { name: '切换 Git 列表' });
    const railWrap = page.locator('.git-rail-wrap');
    const wrapWidth = () => railWrap.evaluate((element) => Math.round(element.getBoundingClientRect().width));
    const board = page.locator('.git-board');
    const boardWidth = () => board.evaluate((element) => Math.round(element.getBoundingClientRect().width));
    const hiddenWidth = Math.round(await railWidth());
    await railToggle.click();
    assert.equal(await bodyPane.getAttribute('data-rail'), 'hidden');
    assert.equal(await rail.evaluate((element) => getComputedStyle(element).display), 'none');
    assert.equal(await railWrap.evaluate((element) => getComputedStyle(element).position), 'absolute');
    const boardBox = await board.boundingBox();
    await page.mouse.move(boardBox.x + boardBox.width - 40, boardBox.y + 40);
    assert.equal(await wrapWidth(), 12);
    await page.mouse.move(boardBox.x + 2, boardBox.y + 40);
    assert.equal(await wrapWidth(), hiddenWidth + 6);
    assert.equal(await rail.evaluate((element) => getComputedStyle(element).display), 'flex');
    const boardWidthBefore = await boardWidth();
    const overlayDividerBox = await divider.boundingBox();
    await page.mouse.move(overlayDividerBox.x + overlayDividerBox.width / 2, overlayDividerBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(overlayDividerBox.x + overlayDividerBox.width / 2 - 40, overlayDividerBox.y + 40);
    await page.mouse.up();
    assert.equal(Math.round(await railWidth() - hiddenWidth), -40);
    assert.equal(await boardWidth(), boardWidthBefore);
    await railToggle.click();
    assert.equal(await bodyPane.getAttribute('data-rail'), 'shown');
    assert.equal(await statusMark(page, 'A').first().evaluate((element) => getComputedStyle(element).color), 'rgb(155, 199, 188)', 'added shares the theme green with the diff tint');
    assert.deepEqual(await page.locator('.git-editor .monaco-editor').first().evaluate((element) => ['--vscode-editor-background', '--vscode-diffEditor-insertedTextBackground', '--vscode-diffEditor-removedTextBackground'].map((name) => getComputedStyle(element).getPropertyValue(name))), ['#121314', 'rgba(155, 199, 188, 0.2)', 'rgba(230, 140, 140, 0.2)']);
    const workerReady = page.waitForEvent('worker');
    await page.evaluate(() => window.MonacoEnvironment.getWorker('', 'editorWorkerService'));
    const worker = await workerReady;
    // A worker exists before it has installed its handler, so the handler is what is waited for.
    await until(() => worker.evaluate(() => typeof self.onmessage === 'function'));
    await diffPane.click({ button: 'right', position: { x: 60, y: 60 } });
    await page.getByRole('menuitem', { name: '关闭' }).click();
    assert.equal(await diffPane.count(), 0);
    assert.ok(await openFile(page).isDisabled(), 'closing the diff clears the file selection');
    await noFile(page).waitFor();
    assert.ok(!(await commitRows(page).first().textContent()).includes('main'));
    const tip = page.locator('.git-tip');
    assert.equal(await tip.count(), 0, 'the detail card only exists while its hover group is active');
    await commitRows(page).first().hover();
    assert.equal(await tip.filter({ hasText: 'main' }).count(), 1);
    assert.equal(await tip.evaluate((element) => getComputedStyle(element).position), 'fixed', 'the card floats outside the rail');
    assert.ok(await rail.evaluate((element) => element.scrollWidth <= element.clientWidth), 'the card does not widen the rail');
    const tipBox = await tip.boundingBox();
    await page.mouse.move(tipBox.x - 4, tipBox.y + 12, { steps: 8 });
    assert.equal(await tip.count(), 1, 'crossing the gap keeps the detail card open');
    await tip.locator('.mono').hover();
    assert.equal(await tip.count(), 1, 'the detail card stays open while its contents are hovered');
    await noFile(page).hover();
    assert.equal(await tip.count(), 0);
    await commitFiles(page).first().click();
    await diffLines(page).filter({ hasText: 'ORIGINAL_VALUE' }).waitFor();
    await openFile(page).click();
    await previewLines.filter({ hasText: 'WORKTREE_VALUE' }).waitFor();
    assert.equal(await previewPath.getAttribute('title'), sample, 'history opens the current working-tree file');
    await closeView(page);
    const deleted = join(repo, 'deleted.ts');
    writeFileSync(deleted, 'const deleted = true;\n');
    git('add', 'deleted.ts'); git('commit', '-qm', 'add file to delete');
    rmSync(deleted);
    await refreshGit(page).click();
    await sectionFiles(page, '未暂存').filter({ hasText: 'deleted.ts', has: statusMark(page, 'D') }).click();
    await page.getByRole('region', { name: 'Diff deleted.ts', exact: true }).waitFor();
    assert.ok(await openFile(page).isDisabled(), 'deleted files cannot be opened');
    assert.equal(await openFile(page).getAttribute('title'), '文件已删除');
    // The page follows the machine on its own: a file written outside it arrives without the refresh button.
    const fresh = join(repo, 'fresh.ts');
    writeFileSync(fresh, 'const fresh = true;\n');
    await railFiles(page).filter({ hasText: 'fresh.ts' }).waitFor();
    // The file the pane shows is watched: writing it changes the diff while the repository stays as it is.
    await railFiles(page).filter({ hasText: 'fresh.ts' }).click();
    await diffLines(page).filter({ hasText: 'fresh = true' }).waitFor();
    writeFileSync(fresh, 'const fresh = "LIVE_TEXT";\n');
    await diffLines(page).filter({ hasText: 'LIVE_TEXT' }).waitFor();
    // A clean entry whose stat data is stale is what a `git status` would otherwise write back (GIT_OPTIONAL_LOCKS=0),
    // so the file is replaced by a copy of itself, same content and same mtime, whose inode the index does not know.
    git('add', '-A');
    const freshStats = statSync(fresh);
    const copy = join(repo, 'fresh.copy');
    copyFileSync(fresh, copy);
    utimesSync(copy, freshStats.atime, freshStats.mtime);
    renameSync(copy, fresh);
    const gitIndex = join(repo, '.git/index');
    const indexBefore = statSync(gitIndex);
    await refreshGit(page).click();
    // The window holds a poll as well as the button.
    await page.waitForTimeout(poll + 1000);
    const indexAfter = statSync(gitIndex);
    assert.deepEqual([indexAfter.mtimeMs, indexAfter.ino, indexAfter.size], [indexBefore.mtimeMs, indexBefore.ino, indexBefore.size], 'reading the repository does not write the index');
    await openView(page, 'Git');
    assert.equal(await viewTabs(page).count(), 1, 'opening the view again takes the tab it already has');
    await run(page, `cd '${home}'`);
    await refreshGit(page).click();
    await notARepository(page).waitFor();
    // A shell that exits leaves the workspace without a terminal, and the Git tab says so.
    await run(page, 'exit');
    await noTerminal(page).waitFor();
  }));

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
    // The workspace follows the shell's directory and tells the tab, which reads the repository again: waiting for the
    // branch waits for that read to land, so the page is idle from here until a read is asked for.
    await mainBranch(page).waitFor();
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

test('A staged diff pane follows the index of the file it shows', { timeout: caseTimeout }, () => withGitApp('wangcai-git-index',
  gitLists,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'repo');
    const file = join(repo, 'indexed.ts');
    writeFileSync(file, "const value = 'ONE';\n");
    git('add', 'indexed.ts'); git('commit', '-qm', 'initial commit');
    writeFileSync(file, "const value = 'TWO';\n"); git('add', 'indexed.ts');
    await readRepo(page, repo, 'repo');
    await sectionFiles(page, '已暂存').filter({ hasText: 'indexed.ts' }).click();
    await modifiedLines(page).filter({ hasText: 'TWO' }).waitFor();
    // The worktree holds a third version the staged side knows nothing about: the read that brings the file to the
    // unstaged group leaves the pane comparing HEAD with the index, which still holds the second version.
    writeFileSync(file, "const value = 'THREE';\n");
    await sectionFiles(page, '未暂存').filter({ hasText: 'indexed.ts' }).waitFor();
    await modifiedLines(page).filter({ hasText: 'TWO' }).waitFor();
    assert.equal(await diffLines(page).filter({ hasText: 'THREE' }).count(), 0, 'the pane reads the index side, not the worktree');
    // Staging that third version moves the index blob without changing how the file is listed, so the pane is read
    // again by the poll that finds the blob other than the one it holds: neither the button nor any other step.
    git('add', 'indexed.ts');
    await modifiedLines(page).filter({ hasText: 'THREE' }).waitFor();
  }));

test('A staged diff pane follows HEAD as well as the index', { timeout: caseTimeout }, () => withGitApp('wangcai-git-head',
  gitLists,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'repo');
    const file = join(repo, 'head.ts');
    writeFileSync(file, "const value = 'ONE';\n");
    git('add', 'head.ts'); git('commit', '-qm', 'first');
    writeFileSync(file, "const value = 'TWO';\n");
    git('add', 'head.ts'); git('commit', '-qm', 'second');
    writeFileSync(file, "const value = 'THREE';\n"); git('add', 'head.ts');
    await readRepo(page, repo, 'repo');
    await sectionFiles(page, '已暂存').filter({ hasText: 'head.ts' }).click();
    await originalLines(page).filter({ hasText: 'TWO' }).waitFor();
    // A soft reset moves HEAD without touching the index or the way the file is listed, so the committed side the
    // pane compares is named by the head blob alone: the poll that finds it other than the one it holds reads again.
    git('reset', '--soft', 'HEAD~1');
    await originalLines(page).filter({ hasText: 'ONE' }).waitFor();
  }));

test('A diff pane closes when the change it shows leaves the list', { timeout: caseTimeout }, () => withGitApp('wangcai-git-close',
  gitLists,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'repo');
    const file = join(repo, 'committed.ts');
    writeFileSync(file, "const value = 'ONE';\n");
    git('add', 'committed.ts'); git('commit', '-qm', 'initial commit');
    writeFileSync(file, "const value = 'TWO';\n");
    await readRepo(page, repo, 'repo');
    await sectionFiles(page, '未暂存').filter({ hasText: 'committed.ts' }).click();
    await diffLines(page).filter({ hasText: 'TWO' }).waitFor();
    // Committing the change takes it out of the list the pane was picked from, so the poll that finds the list
    // without it closes the pane: what is left is no diff at all, not a comparison of two sides that never met. The
    // commit stages the file as it commits it, so no read catches it staged in the list it is about to leave.
    git('commit', '-qam', 'commit the change');
    await noFile(page).waitFor();
    assert.equal(await sectionFiles(page, '未暂存').filter({ hasText: 'committed.ts' }).count(), 0, 'the file leaves the list it was picked from');
    assert.ok(await openFile(page).isDisabled(), 'closing the pane clears the selection');
  }));

test('The diff hands its caret to the opened file and keeps it across reads', { timeout: caseTimeout }, () => withGitApp('wangcai-git-caret',
  gitListsWithFiles,
  async ({ home, env, page }) => {
    const { repo, git } = repoIn(home, env, 'repo');
    // Long enough that a line deep in it is only drawn once a pane is scrolled to it, and every line differs, so the
    // page hides no region of the file.
    const sourceOf = (suffix) => Array.from({ length: 200 }, (_, index) => `const line${index + 1} = ${index + 1}${suffix};\n`).join('');
    const long = join(repo, 'long.ts');
    writeFileSync(long, sourceOf(''));
    git('add', '.'); git('commit', '-qm', 'initial commit');
    writeFileSync(long, sourceOf(' + 1'));
    await readRepo(page, repo, 'repo');
    await sectionFiles(page, '未暂存').filter({ hasText: 'long.ts' }).click();
    await modifiedLines(page).filter({ hasText: 'const line1 = 1 + 1;' }).waitFor();
    // Whether an editor draws a line inside its own pane, compared by the plain spaces the file holds rather than the
    // non-breaking ones the preview draws them as.
    const draws = (selector, editor, text) => page.evaluate(([selector, editor, text]) => {
      const host = document.querySelector(selector);
      const root = (host.shadowRoot ?? host).querySelector(editor);
      const line = [...root.querySelectorAll('.view-line')].find((node) => node.textContent.replace(/\u00a0/g, ' ') === text);
      if (!line) return false;
      const box = line.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      return box.top >= rootBox.top && box.bottom <= rootBox.bottom;
    }, [selector, editor, text]);
    // The caret goes deep into the file the way a reader moves it, with the keyboard: a click lands on a line the page
    // redraws under it, and a pane opens with the caret on its first line.
    const diffSelector = '.git-editor';
    await page.evaluate((selector) => document.querySelector(selector).shadowRoot.querySelector('.editor.modified [tabindex="0"]').focus(), diffSelector);
    for (let step = 0; step < 149; step++) await page.keyboard.press('ArrowDown');
    await openFile(page).click();
    const previewSelector = `${filesPanel} .code-preview`;
    // The line is read off the page, so the preview has to have drawn it before it can be found.
    await page.locator(`${previewSelector} .view-line`).first().waitFor();
    // The toolbar carries the caret to the file it opens, and the preview lands on that same line and column.
    const opened = await page.evaluate(async () => Object.values(await window.wangcai.call('request', 'files', 'history'))[0].entries[0]);
    assert.ok(opened.line > 100, `the caret was deep in the file, not near its top: line ${opened.line}`);
    assert.equal(opened.column, 1);
    assert.ok(await draws(previewSelector, '.monaco-editor', `const line${opened.line} = ${opened.line} + 1;`), 'the preview jumps to the line the diff shows');
    // The preview took the sidebar, and a page that is off show draws no line of its file, so the Git tab comes back.
    await closeView(page);
    // A read that brings new text rewrites the sides the pane holds, so the editor that draws again is the one already
    // on screen: a marker set on it now is still there after the read.
    await diffEditor(page).first().evaluate((element) => { element.dataset.kept = 'changed'; });
    writeFileSync(long, sourceOf(' + 2'));
    // The write reaches the pane through the watch on the file, and a poll inside this window covers a watch that did not.
    await page.waitForTimeout(poll + 1000);
    assert.equal(await diffEditor(page, '[data-kept=changed]').count(), 1, 'the read redraws the diff instead of building another editor');
    assert.ok(await draws(diffSelector, '.editor.modified', `const line${opened.line} = ${opened.line} + 2;`), 'the redrawn diff is still at the caret');
  }));
