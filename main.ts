import type { MachineConnection, WorkspaceActive } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { readGit, type RunGit } from './git';
import type { GitRequest, WatchRequest } from './shared';

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 12 },
    lineHeight: { type: 'number' },
  },
  // Whether the page reads the repository on its own: a poll of `git status`, so a change made outside the window
  // arrives without the refresh button.
  autoRefresh: { type: 'boolean', default: true },
};

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  // One request runs on its own connection to a machine, closed again at the end unless the body keeps it: a watch
  // outlives the request that asked for it.
  const withConnection = async <T>(machine: WorkspaceActive['machine'], body: (connection: MachineConnection, keep: () => void) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    pending.add(controller);
    let connection: MachineConnection | undefined;
    let kept = false;
    try {
      connection = await context.connect(machine, controller.signal);
      controller.signal.throwIfAborted();
      connections.add(connection);
      return await body(connection, () => { kept = true; });
    } finally {
      if (!kept && connection) { connection.disconnect(); connections.delete(connection); }
      pending.delete(controller);
    }
  };
  const handlers = ['overview', 'history', 'files', 'diff'].map(method => context.ui.handle(method, (query: GitRequest) =>
    withConnection(query.terminal.machine, async connection => {
      const cwd = method === 'overview' ? await connection.pty.cwd(query.terminal.sessionId) : query.root!;
      const run: RunGit = async (cwd, args) => {
        const result = await connection.subprocess.exec('git', ['--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...args], {
          cwd, env: { GIT_OPTIONAL_LOCKS: '0' },
        });
        return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr).toString(), code: result.code };
      };
      return await readGit(method, cwd, query, run, path => connection.fs.readFile(path));
    })));
  // One watch set per tab: the window keeps a tab per workspace, and a tab that stops showing something must not stop
  // another tab's watch.
  const watchers = new Map<string, { key: string; connection: MachineConnection; close: () => void }>();
  const asked = new Map<string, string>();
  handlers.push(context.ui.handle('watch', ({ holder, machine, paths }: WatchRequest) => {
    const key = `${machine.host ?? ''}|${JSON.stringify(paths)}`;
    asked.set(holder, key);
    const previous = watchers.get(holder);
    if (previous?.key === key) return;
    // What this tab watched before is given up, since it is about to watch what it shows now.
    if (previous) {
      previous.close();
      // The connection was held only while this tab watched something.
      previous.connection.disconnect();
      connections.delete(previous.connection);
      watchers.delete(holder);
    }
    if (!paths.length) return;
    return withConnection(machine, async (connection, keep) => {
      // A path that cannot be watched is skipped, so one bad path does not cost the others their watch.
      const closes = (await Promise.all(paths.map(path =>
        connection.fs.watch(path, {}, () => context.ui.publish('changed', path)).catch(() => undefined))))
        .filter((close): close is () => void => close !== undefined);
      // A later request from the same tab took the set over while this one was connecting.
      if (asked.get(holder) !== key || !closes.length || watchers.has(holder)) {
        for (const close of closes) close();
        return;
      }
      keep();
      watchers.set(holder, { key, connection, close: () => { for (const close of closes) close(); } });
    });
  }));
  return () => {
    for (const remove of handlers) remove();
    for (const controller of pending) controller.abort();
    for (const connection of connections) connection.disconnect();
  };
}
