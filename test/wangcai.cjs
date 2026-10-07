const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

/**
 * The WangCai checkout next to this repository, which is what runs this plugin. It has to be built: the app
 * launches in place, and it loads this plugin's files from this directory rather than from a packaged copy.
 * Returns undefined when it is not there, so a test can skip rather than fail.
 */
exports.wangcaiApp = () => {
  const root = resolve(__dirname, '../../WangCai');
  const built = ['desktop/dist/main/index.js', 'desktop/node/bin/node', 'wangcaicli/dist/debug/wangcai'];
  return built.every((name) => existsSync(join(root, name))) ? root : undefined;
};

/** The environment a test runs the app in: its own home, and none of the variables a dev run exports. */
exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

/** A plugin checkout next to this one, already built into the files the app loads. */
const checkout = (id) => {
  const directory = resolve(__dirname, `../../WangCai-${id}`);
  return existsSync(join(directory, 'main.cjs')) ? directory : undefined;
};

/** The app loads only what init.ts lists, so a test names the plugins and where to read them from. */
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? {};
  const entry = (item) => {
    const spec = typeof item === 'string' ? { id: item } : item;
    if (!spec.directory && !spec.repo) {
      const directory = checkout(spec.id);
      if (directory) spec.directory = directory;
    }
    return JSON.stringify(spec);
  };
  const list = (entries) => entries.map(entry).join(', ');
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
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
