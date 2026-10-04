const { existsSync } = require('node:fs');
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

/** Waits until a workspace takes input; the terminal attaches a moment after its pane appears. */
exports.waitForTerminal = async (page, sessionId) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const attached = await page.evaluate((session) => window.wangcai.request('terminal-agent', 'pty', { id: 'local', op: 'input', params: { session_id: session, data: '' } }).then(() => true, () => false), sessionId);
    if (attached) return;
    await page.waitForTimeout(50);
  }
  throw new Error('the terminal never attached');
};
