import type { MachineConnection, WorkspaceActive } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { readFiles, readHistory, readOverview, type RunGit } from './git';
import type { FilesRequest, HistoryRequest, OverviewRequest } from './shared';

// What asks the window for the view this plugin draws: the topic it answers, and the plugin id init.ts lists.
const showView = { event: 'core:show-view', data: { plugin: 'git' } };

export const keys = {
  '<leader>gg': { global: true, insert: true, desc: ['git', '打开 Git 视图'], ...showView },
  // The page's own Ctrl+Shift+h and Ctrl+Shift+l: the core's Ctrl+h and Ctrl+l walk the window's panes, so the page
  // keeps this pair for itself and answers it only while it holds the keys.
  '<C-S-h>': { insert: true, desc: '回到 Git 列表', event: 'git:focus-rail' },
  '<C-S-l>': { insert: true, desc: '进入 diff', event: 'git:focus-diff' },
};

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: 'Menlo, monospace' },
  },
  // Whether the page reads the repository on its own: a poll of `git status`, so a change made outside the window
  // arrives without the refresh button.
  autoRefresh: { type: 'boolean', default: true },
};

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  // One request runs on its own connection to a machine, closed again at the end.
  const withConnection = async <T>(machine: WorkspaceActive['machine'], body: (connection: MachineConnection) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    pending.add(controller);
    let connection: MachineConnection | undefined;
    try {
      connection = await context.connect(machine, controller.signal);
      controller.signal.throwIfAborted();
      connections.add(connection);
      return await body(connection);
    } finally {
      if (connection) { connection.disconnect(); connections.delete(connection); }
      pending.delete(controller);
    }
  };
  const runGit = (connection: MachineConnection): RunGit => async (cwd, args) => {
    const result = await connection.subprocess.exec('git', ['--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: { GIT_OPTIONAL_LOCKS: '0' },
    });
    return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr).toString(), code: result.code };
  };
  const handlers = [
    context.ui.handle('overview', (query: OverviewRequest) => withConnection(query.terminal.machine, async connection =>
      readOverview(await connection.pty.cwd(query.terminal.sessionId), runGit(connection)))),
    context.ui.handle('history', (query: HistoryRequest) => withConnection(query.terminal.machine, async connection =>
      readHistory(query, runGit(connection)))),
    context.ui.handle('files', (query: FilesRequest) => withConnection(query.terminal.machine, async connection =>
      readFiles(query, runGit(connection)))),
  ];
  return () => {
    for (const remove of handlers) remove();
    for (const controller of pending) controller.abort();
    for (const connection of connections) connection.disconnect();
  };
}
