const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { _electron: electron } = require('playwright-core');
const { installedApp, linkPlugins, run, stopServer, testEnv, waitForTerminal, writeInit } = require('./wangcai.cjs');

const directory = resolve(__dirname, '..');

test('Git tab follows terminal cwd, opens working-tree files, and shows one read-only diff at a time', { timeout: 180000 }, async (t) => {
  const app = installedApp();
  if (!app) { t.skip('the WangCai app is not installed'); return; }
  // The app loads this directory's build, so the test starts from what the source says now.
  execFileSync(process.execPath, ['build.mjs'], { cwd: directory });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-git-ui-')));
  const env = testEnv(home);
  let desktop;
  try {
    // The workspace the Git tab follows comes from the plugin the installed app already has.
    const plugins = linkPlugins(home);
    if (!plugins || !existsSync(join(plugins, 'terminal-agent/main.cjs')) || !existsSync(join(plugins, 'files/main.cjs'))) {
      t.skip('the installed app has no workspace or files plugin'); return;
    }
    writeInit(home, { workspaces: [{ id: 'terminal-agent', directory: join(plugins, 'terminal-agent') }], tabs: [{ id: 'files', directory: join(plugins, 'files') }, { id: 'git', directory }] });
    const repo = join(home, "repo with 'quote");
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'UI Test'); git('config', 'user.email', 'ui@test.local');
    const unchanged = Array.from({ length: 20 }, (_, index) => `const unchanged${index} = ${index};\n`).join('');
    writeFileSync(join(repo, 'sample.ts'), unchanged + 'const value = "ORIGINAL_VALUE";\n');
    git('add', '.'); git('commit', '-qm', 'initial UI commit');
    writeFileSync(join(repo, 'sample.ts'), unchanged + 'const value = "STAGED_VALUE";\n'); git('add', '.');
    writeFileSync(join(repo, 'sample.ts'), unchanged + 'const value = "WORKTREE_VALUE";\n');
    desktop = await electron.launch({ executablePath: app.executable, args: [`--user-data-dir=${join(home, 'electron')}`], env });
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.locator('.workspaces').waitFor();
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: 'Git', exact: true }).click();
    await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
    await page.locator('.workspaces').click({ button: 'right' });
    await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '本机', exact: true }).click();
    await page.locator('.git-note[role=alert]').filter({ hasText: 'not a git repository' }).waitFor();
    await waitForTerminal(page);
    await run(page, `cd '${repo.replaceAll("'", "'\\''")}'`);
    await page.locator('.xterm-screen').filter({ hasText: 'repo with' }).waitFor();
    await page.getByRole('button', { name: '刷新 Git' }).click();
    await page.locator('.git-branch').filter({ hasText: 'main' }).waitFor();
    const groups = await page.locator('.git-rail').evaluate((rail) => ({
      titles: [...rail.querySelectorAll('summary')].map((node) => node.textContent.trim()),
      arrows: [...rail.querySelectorAll('summary')].map((node) => getComputedStyle(node, '::before').content),
      parts: [...rail.children].map((node) => node.className || node.tagName.toLowerCase()),
      divider: [Math.round(rail.querySelector('.git-gap').getBoundingClientRect().height), getComputedStyle(rail.querySelector('.git-gap')).flexShrink],
    }));
    assert.deepEqual(groups.titles, ['已暂存 1', '未暂存 1'], 'the files are listed without a 改动 or 提交历史 title');
    assert.deepEqual(groups.arrows, ['"▾"', '"▾"'], 'every file group carries its triangle');
    assert.deepEqual(groups.parts, ['details', 'details', 'git-gap', 'git-history'], 'the divider sits between the files and the commits');
    assert.deepEqual(groups.divider, [1, '0'], 'the divider never shrinks away');
    const openFile = page.getByRole('button', { name: '打开文件', exact: true });
    assert.equal(await openFile.isDisabled(), true, 'opening a file requires a selection');
    for (const selector of ['.git-rail > details .git-file', '.git-commit-files .git-file']) {
      const file = page.locator(selector).first();
      await file.hover();
      assert.equal(await file.evaluate((element) => {
        const row = element.getBoundingClientRect();
        const group = element.parentElement.getBoundingClientRect();
        return row.left === group.left && row.right === group.right;
      }), true, 'file hover fills the entire row in both file lists');
    }
    const staged = page.locator('.git-rail > details').filter({ has: page.locator('summary', { hasText: /^已暂存/ }) });
    await staged.locator('.git-file').first().click();
    await page.locator('.git-editor .view-lines').filter({ hasText: 'STAGED_VALUE' }).waitFor();
    // Monaco swaps the rendered lines as the diff changes, so read the font until a live one reports it.
    let font = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      font = await page.locator('.git-editor .view-lines').first().evaluate((element) => {
        const { fontSize, fontFamily } = getComputedStyle(element);
        return { fontSize, fontFamily };
      });
      if (font.fontSize) break;
      await page.waitForTimeout(50);
    }
    assert.equal(font.fontSize, '12px');
    assert.match(font.fontFamily, /^"DejaVuSansM Nerd Font Mono"/);
    assert.equal(await openFile.isEnabled(), true);
    await openFile.click();
    const filePreview = page.locator('.sidebar-panel[data-plugin=files]:visible');
    await filePreview.locator('.code-preview .view-lines').filter({ hasText: 'WORKTREE_VALUE' }).waitFor();
    assert.equal(await filePreview.locator('.preview-path').getAttribute('title'), join(repo, 'sample.ts'));
    await page.locator('.sidebar-tab:has([aria-selected=true]) .close-tab').click();
    const worktree = page.locator('.git-rail > details').filter({ has: page.locator('summary', { hasText: /^未暂存/ }) });
    await worktree.locator('.git-file').first().click();
    await page.locator('.git-editor .editor.modified .view-lines').filter({ hasText: 'WORKTREE_VALUE' }).waitFor();
    assert.equal(await page.locator('.git-pane').count(), 1);
    assert.equal(await page.locator('.git-page[data-reading=auto]').count(), 1);
    const reading = page.getByRole('button', { name: /^阅读方式/ });
    await reading.click();
    assert.equal(await page.locator('.git-page[data-reading=split]').count(), 1);
    assert.equal(await page.getByRole('button', { name: '阅读方式 双栏' }).count(), 1);
    await page.locator('.git-editor .monaco-diff-editor.side-by-side').waitFor();
    const unfold = page.locator('.git-editor .codicon-unfold:visible').first();
    const iconFont = await unfold.evaluate(async (element) => {
      const style = getComputedStyle(element, '::before');
      const faces = await document.fonts.load('16px codicon', style.content.slice(1, -1));
      return { family: style.fontFamily, loaded: faces.length > 0 };
    });
    assert.equal(iconFont.family, 'codicon', 'the expand icon uses the icon font, not the code font');
    assert.equal(iconFont.loaded, true, 'the expand icon font is bundled and loads successfully');
    await unfold.click();
    await unfold.waitFor({ state: 'hidden' });
    await page.locator('.git-editor .editor.original .fold-unchanged:visible').first().click();
    await unfold.waitFor();
    await reading.click();
    assert.equal(await page.locator('.git-page[data-reading=inline]').count(), 1);
    await page.locator('.git-editor .monaco-diff-editor:not(.side-by-side)').waitFor();
    const wrap = page.getByRole('button', { name: '长行折行' });
    assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
    await wrap.click();
    assert.equal(await wrap.getAttribute('aria-pressed'), 'false');
    const rail = page.locator('.git-rail');
    const railWidth = () => rail.evaluate((element) => element.getBoundingClientRect().width);
    const before = await railWidth();
    assert.equal(Math.round(before), 260);
    const body = await page.locator('.git-body').boundingBox();
    const divider = await page.locator('.git-divider').boundingBox();
    const centre = { x: divider.x + divider.width / 2, y: divider.y + divider.height / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 30, centre.y);
    assert.equal(Math.round(await railWidth() - before), 30);
    await page.mouse.move(centre.x + 2000, centre.y);
    await page.mouse.up();
    assert.equal(Math.round(await railWidth()), Math.round(body.width * 0.7));
    await page.locator('.git-divider').hover();
    assert.equal(await page.locator('.git-divider').evaluate((element) => getComputedStyle(element, '::before').backgroundColor), 'rgb(57, 148, 188)');
    const wrapWidth = () => page.locator('.git-rail-wrap').evaluate((element) => Math.round(element.getBoundingClientRect().width));
    const boardWidth = async () => Math.round((await page.locator('.git-board').boundingBox()).width);
    const hidden = Math.round(await railWidth());
    await page.getByRole('button', { name: '切换 Git 列表' }).click();
    assert.equal(await page.locator('.git-body').getAttribute('data-rail'), 'hidden');
    assert.equal(await page.locator('.git-rail').evaluate((element) => getComputedStyle(element).display), 'none');
    assert.equal(await page.locator('.git-rail-wrap').evaluate((element) => getComputedStyle(element).position), 'absolute');
    const board = await page.locator('.git-board').boundingBox();
    await page.mouse.move(board.x + board.width - 40, board.y + 40);
    assert.equal(await wrapWidth(), 12);
    await page.mouse.move(board.x + 2, board.y + 40);
    assert.equal(await wrapWidth(), hidden + 4);
    assert.equal(await page.locator('.git-rail').evaluate((element) => getComputedStyle(element).display), 'flex');
    const uncovered = await boardWidth();
    const overlayDivider = await page.locator('.git-divider').boundingBox();
    await page.mouse.move(overlayDivider.x + overlayDivider.width / 2, overlayDivider.y + 40);
    await page.mouse.down();
    await page.mouse.move(overlayDivider.x + overlayDivider.width / 2 - 40, overlayDivider.y + 40);
    await page.mouse.up();
    assert.equal(Math.round(await railWidth() - hidden), -40);
    assert.equal(await boardWidth(), uncovered);
    await page.getByRole('button', { name: '切换 Git 列表' }).click();
    assert.equal(await page.locator('.git-body').getAttribute('data-rail'), 'shown');
    assert.equal(await page.locator('.git-status-A').first().evaluate((element) => getComputedStyle(element).color), 'rgb(155, 199, 188)', 'added shares the theme green with the diff tint');
    assert.deepEqual(await page.locator('.git-editor .monaco-editor').first().evaluate((element) => ['--vscode-editor-background', '--vscode-diffEditor-insertedTextBackground', '--vscode-diffEditor-removedTextBackground'].map((name) => getComputedStyle(element).getPropertyValue(name))), ['#121314', 'rgba(155, 199, 188, 0.2)', 'rgba(230, 140, 140, 0.2)']);
    const workerReady = page.waitForEvent('worker');
    await page.evaluate(() => window.MonacoEnvironment.getWorker('', 'editorWorkerService'));
    const worker = await workerReady;
    assert.equal(await worker.evaluate(() => typeof self.onmessage), 'function');
    await page.locator('.git-pane').click({ button: 'right', position: { x: 60, y: 60 } });
    await page.getByRole('menuitem', { name: '关闭' }).click();
    assert.equal(await page.locator('.git-pane').count(), 0);
    assert.equal(await openFile.isDisabled(), true, 'closing the diff clears the file selection');
    await page.getByText('选择文件查看 diff', { exact: true }).waitFor();
    assert.equal((await page.locator('.git-commit-row').first().textContent()).includes('main'), false);
    assert.equal(await page.locator('.git-tip').count(), 0, 'the detail card only exists while its hover group is active');
    await page.locator('.git-commit-row').first().hover();
    assert.equal(await page.locator('.git-tip').filter({ hasText: 'main' }).count(), 1);
    assert.equal(await page.locator('.git-tip').evaluate((element) => getComputedStyle(element).position), 'fixed', 'the card floats outside the rail');
    assert.equal(await page.locator('.git-rail').evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'the card does not widen the rail');
    const tip = page.locator('.git-tip');
    const tipBox = await tip.boundingBox();
    await page.mouse.move(tipBox.x - 4, tipBox.y + 12, { steps: 8 });
    assert.equal(await tip.count(), 1, 'crossing the gap keeps the detail card open');
    await tip.locator('.mono').hover();
    assert.equal(await tip.count(), 1, 'the detail card stays open while its contents are hovered');
    await page.locator('.git-board > .git-note').hover();
    assert.equal(await page.locator('.git-tip').count(), 0);
    await page.locator('.git-commit-files .git-file').first().click();
    await page.locator('.git-editor .view-lines').filter({ hasText: 'ORIGINAL_VALUE' }).waitFor();
    await openFile.click();
    await filePreview.locator('.code-preview .view-lines').filter({ hasText: 'WORKTREE_VALUE' }).waitFor();
    assert.equal(await filePreview.locator('.preview-path').getAttribute('title'), join(repo, 'sample.ts'), 'history opens the current working-tree file');
    await page.locator('.sidebar-tab:has([aria-selected=true]) .close-tab').click();
    writeFileSync(join(repo, 'deleted.ts'), 'const deleted = true;\n');
    git('add', 'deleted.ts'); git('commit', '-qm', 'add file to delete');
    rmSync(join(repo, 'deleted.ts'));
    await page.getByRole('button', { name: '刷新 Git' }).click();
    await page.locator('.git-rail > details .git-file').filter({ hasText: 'deleted.ts', has: page.locator('.git-status-D') }).click();
    await page.getByRole('region', { name: 'Diff deleted.ts', exact: true }).waitFor();
    assert.equal(await openFile.isDisabled(), true, 'deleted files cannot be opened');
    assert.equal(await openFile.getAttribute('title'), '文件已删除');
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: 'Git', exact: true }).click();
    assert.equal(await page.locator('.sidebar-tab:visible').count(), 1);
    await run(page, `cd '${home}'`);
    await page.getByRole('button', { name: '刷新 Git' }).click();
    await page.locator('.git-note[role=alert]').filter({ hasText: 'not a git repository' }).waitFor();
    // A shell that exits leaves the workspace without a terminal, and the Git tab says so.
    await run(page, 'exit');
    await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    stopServer(app.bundle, env);
    rmSync(home, { recursive: true, force: true });
  }
});
test('Git history loads the next page when the rail is scrolled to its end', { timeout: 180000 }, async (t) => {
  const app = installedApp();
  if (!app) { t.skip('the WangCai app is not installed'); return; }
  execFileSync(process.execPath, ['build.mjs'], { cwd: directory });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-git-page-')));
  const env = testEnv(home);
  let desktop;
  try {
    const plugins = linkPlugins(home);
    if (!plugins || !existsSync(join(plugins, 'terminal-agent/main.cjs'))) {
      t.skip('the installed app has no workspace plugin'); return;
    }
    writeInit(home, { workspaces: [{ id: 'terminal-agent', directory: join(plugins, 'terminal-agent') }], tabs: [{ id: 'git', directory }] });
    // More commits than the 50 the first page holds, so the rail has a second page to reach.
    const total = 55;
    const repo = join(home, 'paging');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'UI Test'); git('config', 'user.email', 'ui@test.local');
    for (let index = 0; index < total; index++) {
      writeFileSync(join(repo, 'count.txt'), `${index}\n`);
      git('add', 'count.txt'); git('commit', '-qm', `commit ${index}`);
    }
    desktop = await electron.launch({ executablePath: app.executable, args: [`--user-data-dir=${join(home, 'electron')}`], env });
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.locator('.workspaces').waitFor();
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: 'Git', exact: true }).click();
    await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
    await page.locator('.workspaces').click({ button: 'right' });
    await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '本机', exact: true }).click();
    await waitForTerminal(page);
    await run(page, `cd '${repo}'`);
    await page.locator('.xterm-screen').filter({ hasText: 'paging' }).waitFor();
    await page.getByRole('button', { name: '刷新 Git' }).click();
    await page.locator('.git-branch').filter({ hasText: 'main' }).waitFor();
    const rows = page.locator('.git-commit-row');
    assert.equal(await rows.count(), 50, 'the first page stops at 50 commits');
    const rail = await page.locator('.git-rail').boundingBox();
    await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height / 2);
    // Only the wheel touches the rail from here on: reaching its end is what fetches the second page.
    for (let attempt = 0; attempt < 20 && await rows.count() === 50; attempt++) await page.mouse.wheel(0, 400);
    assert.equal(await rows.count(), total, 'scrolling to the end appends the older commits');
    assert.match(await rows.last().textContent(), /commit 0/, 'the appended page keeps the history order');
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    stopServer(app.bundle, env);
    rmSync(home, { recursive: true, force: true });
  }
});