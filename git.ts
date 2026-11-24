import type { Commit, Comparison, FilesRequest, GitFile, History, HistoryRequest, Overview } from './shared';

export type RunGit = (cwd: string, args: string[]) => Promise<{ stdout: Buffer; stderr: string; code: number }>;
type Git = (args: string[]) => Promise<Buffer>;
const logFormat = '%H%x00%an%x00%at%x00%D%x00%s';

const gitOf = (cwd: string, run: RunGit): Git => async (args) => {
  const result = await run(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`);
  return result.stdout;
};
const revision = (value: string) => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Invalid commit ID');
  return value;
};

const log = async (git: Git, head: string, skip = 0): Promise<History> => {
  if (!head) return { commits: [], hasMore: false };
  if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid history offset');
  const fields = (await git(['log', '-z', `--format=${logFormat}`, '--decorate=full', '-n', '51', `--skip=${skip}`, revision(head), '--'])).toString().split('\0');
  const commits: Commit[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    commits.push({ sha: fields[i], author: fields[i + 1], time: Number(fields[i + 2]), refs: fields[i + 3].split(', ').filter(Boolean), subject: fields[i + 4] });
  }
  return { commits: commits.slice(0, 50), hasMore: commits.length > 50 };
};

export async function readOverview(cwd: string, run: RunGit): Promise<Overview> {
  const git = gitOf(cwd, run);
  const root = (await git(['rev-parse', '--show-toplevel'])).toString().replace(/\r?\n$/, '');
  const fields = (await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])).toString().split('\0');
  const result: Overview = { root, branch: '', upstream: '', ahead: 0, behind: 0, head: '', changes: [], commits: [], hasMore: false, truncated: false };
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('# branch.oid ')) result.head = field.slice(13) === '(initial)' ? '' : field.slice(13);
    else if (field.startsWith('# branch.head ')) result.branch = field.slice(14);
    else if (field.startsWith('# branch.upstream ')) result.upstream = field.slice(18);
    else if (field.startsWith('# branch.ab ')) {
      const [ahead, behind] = field.slice(12).split(' ');
      result.ahead = Number(ahead); result.behind = -Number(behind);
    } else if (field[0] === '?') result.changes.push({ path: field.slice(2), status: '?', stage: 'untracked' });
    else if (field[0] === 'u') {
      const parts = field.split(' ');
      result.changes.push({ path: parts.slice(10).join(' '), status: 'U', stage: 'conflicted' });
    } else if (field[0] === '1' || field[0] === '2') {
      const parts = field.split(' ');
      const path = parts.slice(field[0] === '1' ? 8 : 9).join(' ');
      const oldPath = field[0] === '2' ? fields[++i] : undefined;
      if (parts[1][0] !== '.') result.changes.push({ path, oldPath, status: parts[1][0], stage: 'staged' });
      if (parts[1][1] !== '.') result.changes.push({ path, status: parts[1][1], stage: 'unstaged' });
    }
  }
  result.truncated = result.changes.length > 1000;
  result.changes = result.changes.slice(0, 1000);
  Object.assign(result, await log(git, result.head));
  return result;
}

export async function readHistory(request: HistoryRequest, run: RunGit): Promise<History> {
  return log(gitOf(request.root, run), request.head, request.skip);
}

export async function readFiles(request: FilesRequest, run: RunGit): Promise<GitFile[]> {
  const git = gitOf(request.root, run);
  const sha = revision(request.rev);
  const parents = (await git(['rev-list', '--parents', '-n', '1', sha, '--'])).toString().trim().split(' ');
  const fields = (await git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', '-M', ...(parents[1] ? [parents[1], sha] : [sha]), '--'])).toString().split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++][0];
    const first = fields[i++];
    if (status === 'R' || status === 'C') files.push({ status, oldPath: first, path: fields[i++] });
    else files.push({ status, path: first });
  }
  return files;
}

// The change as the patch git itself prints: each source names the two sides git diff reads, so the preview is the
// command's own output rather than a second diffing of the two texts.
export async function readPatch(root: string, comparison: Comparison, run: RunGit): Promise<string> {
  const path = comparison.path;
  if (!path || path.includes('\0') || path.split('/').includes('..')) throw new Error('Invalid repository path');
  const args = comparison.source === 'commit' ? ['show', '--format=', revision(comparison.rev), '--', path]
    : comparison.source === 'staged' ? ['diff', '--cached', '-M', '--', path]
    : comparison.source === 'unstaged' ? ['diff', '-M', '--', path]
    : comparison.source === 'untracked' ? ['diff', '--no-index', '--', '/dev/null', path]
    : ['diff', '--ours', '--', path];
  const result = await run(root, args);
  // --no-index exits 1 when the two files differ, which is the comparison's whole point.
  if (result.code !== 0 && !(comparison.source === 'untracked' && result.code === 1)) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`);
  }
  return result.stdout.toString();
}
