const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { _electron: electron } = require('playwright-core');

// The app runs in place, so a test uses the checkout next to this repository, not an installed app.
const wangcaiApp = () => {
  const root = resolve(__dirname, '../../WangCai');
  const built = ['desktop/dist/main/index.js', 'desktop/node/bin/node', 'wangcaicli/dist/debug/wangcai'];
  if (!built.every((name) => existsSync(join(root, name)))) throw new Error('build the WangCai checkout next to this repository');
  return root;
};

/** The environment a test runs the app in: its own home, and none of the variables a dev run exports. */
exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

/** Launches the checkout's Electron, which loads this repository's build of the plugin. */
exports.launchApp = (home, env) => {
  const app = wangcaiApp();
  return electron.launch({
    executablePath: require(join(app, 'node_modules/electron')),
    args: [join(app, 'desktop'), `--user-data-dir=${join(home, 'electron')}`],
    cwd: app,
    env,
  });
};

/** The app loads only what init.ts lists, so a test names the plugins and where to read them from. */
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? {};
  const entryText = (item) => {
    const spec = typeof item === 'string' ? { id: item } : item;
    // The plugins beside this repository are the checkouts the tests run against.
    if (!spec.directory && !spec.repo) {
      const directory = resolve(__dirname, `../../WangCai-${spec.id}`);
      if (!existsSync(join(directory, 'main.cjs'))) throw new Error(`build the WangCai-${spec.id} checkout next to this repository`);
      spec.directory = directory;
    }
    return JSON.stringify(spec);
  };
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${workspaces.map(entryText).join(', ')}], tabs: [${tabs.map(entryText).join(', ')}] };\n`);
};

/** Stops the agent the app started for the local machine, which outlives the window that asked for it. */
exports.stopServer = (env) => {
  try { execFileSync(join(wangcaiApp(), 'wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
};

/** Opens the sidebar's Git tab and a local workspace for it: the step every Git test starts with. */
exports.openGitTab = async (page) => {
  await page.locator('.workspaces').waitFor();
  // The window is drawn before its plugins are loaded, so the sidebar waits for one to list them.
  await page.locator('#view-menu button').first().waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '切换右侧栏' }).click();
  await page.getByRole('button', { name: '新建侧栏标签页' }).click();
  await page.locator('#view-menu').getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
  await page.locator('.workspaces').click({ button: 'right' });
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
};

/** Waits until a workspace takes input; the terminal attaches a moment after its pane appears. */
exports.waitForTerminal = (page) => page.waitForFunction(() => (document.querySelector('.terminal-pane.active .xterm-rows')?.textContent ?? '').trim().length > 0);

/** Collects what the page reports on its own, which a test asserts is nothing: a plugin that throws fails its test. */
exports.trackErrors = (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
};

exports.run = async (page, line) => {
  await page.locator('.terminal-pane.active .xterm-helper-textarea').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};