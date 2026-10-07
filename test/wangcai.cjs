const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, symlinkSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

/** The installed app, which is what runs this plugin. WANGCAI_APP points a test at another copy of it. */
exports.installedApp = () => {
  const bundle = process.env.WANGCAI_APP ?? '/Applications/旺财.app';
  const executable = join(bundle, 'Contents/MacOS/旺财');
  return existsSync(executable) ? { bundle, executable } : undefined;
};

/** The environment a test runs the app in: its own home, and none of the variables a dev run exports. */
exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

/**
 * The app reads its plugins from the data directory of the home it runs on, so a test shares the plugins the
 * installed app keeps in the real home instead of cloning and building them again.
 */
exports.linkPlugins = (home) => {
  const installed = join(homedir(), '.local/share/wangcai/plugins');
  if (!existsSync(installed)) return undefined;
  const storage = join(home, '.local/share/wangcai');
  mkdirSync(storage, { recursive: true });
  symlinkSync(installed, join(storage, 'plugins'));
  return join(storage, 'plugins');
};

/** The app loads only what init.ts lists, so a test names the plugins and where to read them from. */
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? {};
  const list = (entries) => entries.map((entry) => JSON.stringify(typeof entry === 'string' ? { id: entry } : entry)).join(', ');
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
};

/** Stops the agent the app started for the local machine, which outlives the window that asked for it. */
exports.stopServer = (bundle, env) => {
  try { execFileSync(join(bundle, 'Contents/Resources/wangcai'), ['server', 'stop'], { env, stdio: 'ignore' }); } catch {}
};

/** Waits until a workspace takes input; the terminal attaches a moment after its pane appears. */
exports.waitForTerminal = async (page, sessionId) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const attached = await page.evaluate((session) => window.wangcai.request('terminal-agent', 'pty', { op: 'input', sessionId: session, params: { data: '' } }).then(() => true, () => false), sessionId);
    if (attached) return;
    await page.waitForTimeout(50);
  }
  throw new Error('the terminal never attached');
};