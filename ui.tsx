import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, KeyboardEvent, UIEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { FileClick, WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { bindKeys, pressIn } from '@lengmoxxl/sdk/keys';
import type { Commit, Comparison, Font, GitFile, History, Overview, Settings, Stage } from './shared';
import './style.css';

export const title = 'Git';
let font: Font;
let activeWorkspaceId: string | undefined;
const stages: Record<Stage, string> = { conflicted: '冲突', staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' };

// The page's layout is a habit of the reader rather than of a repository, so one store holds it for every workspace: a
// width or a folded section changed in one Git tab is drawn by the others as well, and outlives them.
type PageLayout = { railShown: boolean; railWidth: number; folded: Stage[] };
const layoutDefaults: PageLayout = { railShown: true, railWidth: 260, folded: [] };
const layoutKey = 'git-layout';
const layoutListeners = new Set<() => void>();
let layoutHeld: PageLayout | undefined;
const readLayout = (): PageLayout => layoutHeld ??= (() => {
  try { return { ...layoutDefaults, ...JSON.parse(localStorage.getItem(layoutKey) ?? '{}') }; } catch { return layoutDefaults; }
})();
const writeLayout = (patch: Partial<PageLayout>) => {
  layoutHeld = { ...readLayout(), ...patch };
  localStorage.setItem(layoutKey, JSON.stringify(layoutHeld));
  for (const listener of layoutListeners) listener();
};
const watchLayout = (listener: () => void) => { layoutListeners.add(listener); return () => { layoutListeners.delete(listener); }; };

// A rail row is named by the key the cursor holds: the kind of row, then whatever names it.
const rowKey = {
  stage: (stage: Stage) => `stage:${stage}`,
  change: (stage: Stage, path: string) => `change:${stage}:${path}`,
  commit: (sha: string) => `commit:${sha}`,
  commitFile: (sha: string, path: string) => `commitfile:${sha}:${path}`,
};

// The mark a row draws while the keys hold it: an empty value the walk reads back off the page.
const mark = (cursor: string, row: string) => cursor === row ? '' : undefined;

// A repository root and a path inside it, as the machine's absolute path: '/' is the one root that adds nothing.
const absolute = (root: string, path: string) => `${root === '/' ? '' : root}/${path}`;

// Handing a file to the editor is one protocol: the click that names it, then the view that reads it.
const openInEditor = (context: UiContext, machine: WorkspaceActive['machine'], path: string, line?: number) => {
  void context.global.publish('onclick', { type: 'file', machine, path, line } satisfies FileClick);
  void context.global.publish('core:show-view', { plugin: 'editor' });
};

// The comparison as the resource the editor reads: git://<path>@<base>~<head>, the two sides named by revision or by
// the index/worktree tokens, with the old name a rename gives carried for the old side.
const comparisonUri = (root: string, comparison: Comparison): string => {
  const path = absolute(root, comparison.path);
  const old = comparison.oldPath ? `?old=${absolute(root, comparison.oldPath)}` : '';
  const pair = comparison.source === 'commit' ? `${comparison.rev}^~${comparison.rev}`
    : comparison.source === 'staged' ? 'HEAD~:index'
    : comparison.source === 'untracked' ? ':empty~:worktree'
    : comparison.source === 'conflicted' ? ':ours~:worktree'
    : `:index~${comparison.status === 'D' ? ':empty' : ':worktree'}`;
  return `git://${path}@${pair}${old}`;
};

function FileRow({ file, row, cursor, select }: { file: GitFile; row: string; cursor: string; select: () => void }) {
  const cut = file.path.lastIndexOf('/');
  return <button className="git-file" data-row={row} data-path={file.path} data-cursor={mark(cursor, row)} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={select}>
    <span className={`git-status git-status-${file.status}`}>{file.status}</span>
    <span className="git-path">{cut < 0 ? file.path : <>
      <span className="git-dir">{file.path.slice(0, cut + 1)}</span><span>{file.path.slice(cut + 1)}</span>
    </>}</span>
  </button>;
}

function CommitRow({ commit, context, terminal, root, selected, cursor, toggle, select }: {
  commit: Commit; context: UiContext; terminal: WorkspaceActive; root: string; selected: boolean; cursor: string;
  toggle: () => void; select: (comparison: Comparison) => void;
}) {
  const row = rowKey.commit(commit.sha);
  const [files, setFiles] = useState<GitFile[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!selected || files) return;
    let alive = true;
    setError('');
    void context.ui.request<GitFile[]>('files', { terminal, root, rev: commit.sha }).then(value => { if (alive) setFiles(value); })
      .catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [selected, context, terminal, root, commit.sha, files]);
  const [tip, setTip] = useState<{ top: number; left: number }>();
  const tipElement = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = tipElement.current;
    if (!tip || !node) return;
    node.style.left = `${Math.max(8, Math.min(tip.left, window.innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(tip.top, window.innerHeight - node.offsetHeight - 8))}px`;
  }, [tip]);
  return <>
    <div onMouseLeave={() => setTip(undefined)}>
      <button className="git-commit-row" data-row={row} data-cursor={mark(cursor, row)} aria-expanded={selected} onClick={toggle} onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setTip({ top: rect.top, left: rect.right + 8 });
      }}>
        <span>{selected ? '▾' : '▸'}</span>
        <span className="git-subject">{commit.subject}</span>
      </button>
      {tip && <div className="git-tip" ref={tipElement}>
        <div><b>{commit.subject}</b></div>
        <div className="mono">{commit.sha}</div>
        <div>{commit.author} · {new Date(commit.time * 1000).toLocaleString()}</div>
        <div>{commit.refs.map(ref => ref.replace(/refs\/(heads|remotes|tags)\//g, '')).join(' · ') || '没有引用'}</div>
      </div>}
    </div>
    {selected && <div className="git-commit-files" data-commit={row}>
      {error ? <div className="git-note" role="alert">{error}</div> : !files ? <div className="git-note">正在读取…</div>
        : files.length ? files.map(file => <FileRow key={file.path} file={file} row={rowKey.commitFile(commit.sha, file.path)} cursor={cursor} select={() => select({ ...file, source: 'commit', rev: commit.sha })} />)
        : <div className="git-note">没有文件改动</div>}
    </div>}
  </>;
}

// How long an open page waits between two reads of the repository, when `autoRefresh` is on.
const pollMilliseconds = 3000;

type PatchLine = { text: string; kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; newLine?: number };

// The patch git prints, line by line, each new-side line numbered so the cursor can land in the file: @@ sets the
// counter, + and context lines advance it, - lines belong to the old side only.
const parsePatch = (patch: string): PatchLine[] => {
  const raw = patch.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const lines: PatchLine[] = [];
  let next = 1;
  for (const text of raw) {
    if (text.startsWith('@@')) {
      const at = text.match(/\+(\d+)/);
      next = at ? Number(at[1]) : 1;
      lines.push({ text, kind: 'hunk', newLine: next });
    } else if (text.startsWith('+')) {
      lines.push({ text, kind: 'add', newLine: next++ });
    } else if (text.startsWith('-')) {
      lines.push({ text, kind: 'del' });
    } else if (text.startsWith(' ')) {
      lines.push({ text, kind: 'ctx', newLine: next++ });
    } else {
      lines.push({ text, kind: 'meta' });
    }
  }
  return lines;
};

// Which pane last held the keyboard, so returning to the view seats it there again rather than always at the list.
let lastPane: 'history' | 'patch' = 'history';

// The whole patch as a read-only vim view: a block cursor walks it with h/j/k/l, gg/G and a count, and Enter opens the
// line it sits on in the editor.
function DiffPreview({ context, terminal, root, comparison }: { context: UiContext; terminal: WorkspaceActive; root: string; comparison: Comparison }) {
  const [patch, setPatch] = useState<string>();
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState({ line: 0, col: 0 });
  const element = useRef<HTMLDivElement>(null);
  const count = useRef('');
  const pendingG = useRef(false);
  useEffect(() => {
    let alive = true;
    setPatch(undefined); setError(''); setCursor({ line: 0, col: 0 });
    void context.ui.request<string>('diff', { terminal, root, comparison })
      .then(value => { if (alive) setPatch(value); })
      .catch((problem: Error) => { if (alive) setError(problem.message); });
    return () => { alive = false; };
  }, [context, terminal, root, comparison]);
  const lines = useMemo(() => parsePatch(patch ?? ''), [patch]);
  const showEditor = (path: string, line?: number) => openInEditor(context, terminal.machine, path, line);
  // A freshly opened pane takes the keyboard.
  useEffect(() => {
    const node = element.current;
    const at = document.activeElement;
    // This mount effect runs before the list's focusin watcher is attached, so it records the pane itself.
    if (node && !(at instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(at.tagName))) { lastPane = 'patch'; node.focus(); }
  }, []);
  useEffect(() => { element.current?.querySelectorAll('.git-diff-line')[cursor.line]?.scrollIntoView({ block: 'nearest' }); }, [cursor.line, lines]);
  const open = (at: number) => { const line = lines[at]; if (line?.newLine) showEditor(comparisonUri(root, comparison), line.newLine); };
  const seatedCol = (line: number, col: number) => Math.min(col, Math.max(0, (lines[line]?.text.length ?? 1) - 1));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const key = event.key;
    if (/^[0-9]$/.test(key) && !(key === '0' && count.current === '')) { count.current += key; event.preventDefault(); return; }
    const step = Number(count.current) || 1;
    count.current = '';
    if (key === 'g') { if (pendingG.current) { setCursor({ line: 0, col: 0 }); pendingG.current = false; } else pendingG.current = true; event.preventDefault(); return; }
    pendingG.current = false;
    const last = lines.length - 1;
    if (key === 'j') { setCursor(c => { const line = Math.min(last, c.line + step); return { line, col: seatedCol(line, c.col) }; }); event.preventDefault(); }
    else if (key === 'k') { setCursor(c => { const line = Math.max(0, c.line - step); return { line, col: seatedCol(line, c.col) }; }); event.preventDefault(); }
    else if (key === 'h') { setCursor(c => ({ ...c, col: Math.max(0, c.col - step) })); event.preventDefault(); }
    else if (key === 'l') { setCursor(c => ({ ...c, col: seatedCol(c.line, c.col + step) })); event.preventDefault(); }
    else if (key === 'G') { setCursor(c => ({ line: last, col: seatedCol(last, c.col) })); event.preventDefault(); }
    else if (key === 'Enter') { open(cursor.line); event.preventDefault(); }
  };
  const col = seatedCol(cursor.line, cursor.col);
  return <div className="git-diff" ref={element} tabIndex={0} onKeyDown={onKeyDown}>
    <div className="git-diff-head">
      <span className="git-diff-path" title={comparison.oldPath ? `${comparison.oldPath} → ${comparison.path}` : comparison.path}>{comparison.path}</span>
      <button className="git-diff-open" onClick={() => showEditor(absolute(root, comparison.path))}>打开文件</button>
    </div>
    {error ? <div className="git-note" role="alert">{error}</div>
      : patch === undefined ? <div className="git-note">正在读取…</div>
      : !lines.length ? <div className="git-note">无改动</div>
      : lines.map((line, at) => {
          const active = at === cursor.line;
          return <div key={at} data-line={line.newLine} data-col={active ? col : undefined} className={`git-diff-line ${line.kind}${active ? ' git-diff-active' : ''}`} onClick={(event) => {
            const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
            let clicked = 0;
            if (range && event.currentTarget.contains(range.startContainer)) {
              const before = range.cloneRange();
              before.selectNodeContents(event.currentTarget);
              before.setEnd(range.startContainer, range.startOffset);
              clicked = before.toString().length;
            }
            setCursor({ line: at, col: seatedCol(at, clicked) });
            open(at);
          }}>
            {active ? <>{line.text.slice(0, col)}<span className="git-cursor">{line.text[col] ?? ' '}</span>{line.text.slice(col + 1)}</> : line.text || ' '}
          </div>;
        })}
  </div>;
}

function Repository({ context, terminal, activation, autoRefresh }: { context: UiContext; terminal: WorkspaceActive; activation: number; autoRefresh: boolean }) {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const [toolbarRead, setToolbarRead] = useState(0);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const { railShown, railWidth, folded } = useSyncExternalStore(watchLayout, readLayout);
  // Whether the keys slid the hidden list out, as the pointer does: the slide goes away with the file it chose.
  const [railPeek, setRailPeek] = useState(false);
  // The row the rail's keys hold, named by the row's own key, so a read that redraws the list leaves it on that row.
  const [cursor, setCursor] = useState('');
  // The change the board previews: choosing a file renders its patch here, and a hunk a click opens in the editor.
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ origin: number; width: number }>(undefined);
  const railMinimum = 180;
  const railMaximum = Math.round((body.current?.clientWidth ?? 0) * 0.7);
  const clampWidth = (requested: number) => Math.round(Math.max(railMinimum, Math.min(railMaximum, requested)));
  const generation = useRef(0);
  const repositoryRoot = useRef('');
  const busy = useRef(false); // a poll skips the read in flight instead of piling up
  const lastRead = useRef(''); // what the last read found, as the text the next one is compared against
  const paging = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); paging.current = false; setError('');
    // The page follows the machine by asking git for the repository again: the index holds each file's stat data, so a
    // repeated status reads what changed instead of the whole tree. A read that finds the repository the last one did
    // is left alone, so a poll of an unchanged tree redraws nothing.
    const read = (forced: boolean) => {
      if (!forced && busy.current) return;
      busy.current = true;
      void context.ui.request<Overview>('overview', { terminal }).then(value => {
        if (current !== generation.current) return;
        const text = JSON.stringify(value);
        if (!forced && text === lastRead.current) return;
        lastRead.current = text;
        if (repositoryRoot.current !== value.root) { setOpened(value.commits[0]?.sha ?? null); setComparison(null); }
        repositoryRoot.current = value.root;
        setOverview(value);
        setError('');
      }).catch((error: Error) => {
        if (current !== generation.current) return;
        // A read that failed has nothing to compare against, so the page is drawn again by the read that works.
        lastRead.current = '';
        setOverview(undefined); setError(error.message);
      })
        .finally(() => {
          busy.current = false;
          if (forced && current === generation.current) setLoading(false);
        });
    };
    read(true);
    const timer = autoRefresh ? setInterval(() => read(false), pollMilliseconds) : undefined;
    return () => { clearInterval(timer); generation.current++; };
  }, [context, terminal, toolbarRead, activation, autoRefresh]);
  const loadOlder = () => {
    if (!overview?.hasMore || loading || paging.current) return;
    const current = generation.current;
    paging.current = true;
    void context.ui.request<History>('history', { terminal, root: overview.root, head: overview.head, skip: overview.commits.length }).then(value => {
      if (current === generation.current) setOverview(previous => ({ ...previous!, commits: [...previous!.commits, ...value.commits], hasMore: value.hasMore }));
    }).catch((error: Error) => { if (current === generation.current) setError(error.message); })
      .finally(() => { paging.current = false; });
  };
  const endReached = (event: UIEvent<HTMLElement>) => {
    const rail = event.currentTarget;
    if (rail.scrollHeight - rail.scrollTop - rail.clientHeight <= 80) loadOlder();
  };
  const summaryOf = (details: Element) => details.querySelector<HTMLElement>('summary');
  // The rail's rows as the page draws them: a folded section keeps the summary that reopens it and loses the rows
  // under it, so one walk covers every row the keys can reach.
  const rows = () => [...(body.current?.querySelectorAll<HTMLElement>('.git-rail [data-row]') ?? [])]
    .filter((row) => {
      const closed = row.closest('details:not([open])');
      return !closed || row === summaryOf(closed);
    });
  // The row the keys hold takes the focus with the cursor, so a press that folds a section lands on something the keys read.
  const occupy = (row: HTMLElement) => { setCursor(row.dataset.row!); row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); };
  const isHeld = (row: HTMLElement) => row.hasAttribute('data-cursor');
  const heldRow = () => rows().find(isHeld);
  const step = (delta: number) => {
    const list = rows();
    if (!list.length) return;
    const at = list.findIndex(isHeld);
    // A list the cursor is not in yet is entered at its top, whichever way the key walks.
    occupy(list[at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + delta))]);
  };
  const jump = (to: 'first' | 'last') => {
    const list = rows();
    if (list.length) occupy(list[to === 'first' ? 0 : list.length - 1]);
  };
  const foldTo = (details: HTMLDetailsElement, closed: boolean) => {
    const stage = details.dataset.stage as Stage;
    writeLayout({ folded: closed ? (folded.includes(stage) ? folded : [...folded, stage]) : folded.filter((one) => one !== stage) });
  };
  // Choosing a file from the rail previews its change in the board; a hunk or the open button is what hands it to the editor.
  const show = (next: Comparison) => {
    setRailPeek(false);
    setComparison(next);
  };
  // leader gf opens the held file as a normal editable view rather than a comparison: the worktree file itself.
  const openHeldFile = () => {
    const path = heldRow()?.dataset.path;
    if (!path || !overview) return;
    setRailPeek(false);
    openInEditor(context, terminal.machine, absolute(overview.root, path));
  };
  const into = () => {
    heldRow()?.click();
    // The click renders the preview and the rail's occupy takes the focus back; hand the keys over once that settles.
    requestAnimationFrame(() => body.current?.closest('[data-plugin]')?.querySelector<HTMLElement>('.git-diff')?.focus());
  };
  const out = () => {
    const row = heldRow();
    if (!row) return;
    // Closing fires on what is open: a row inside a section closes it through its summary, a commit's file closes the
    // commit row its list names, and a commit row itself says it is open through aria-expanded.
    const details = row.closest('details');
    if (details) {
      if (details.open) summaryOf(details)!.click();
      return;
    }
    const list = row.closest<HTMLElement>('.git-commit-files');
    const commit = list && rows().find((one) => one.dataset.row === list.dataset.commit);
    if (commit) { commit.click(); occupy(commit); }
    else if (row.getAttribute('aria-expanded') === 'true') row.click();
  };
  // The row the keys land on when they come back to the list: the one they were on, or the list's top.
  const seatRow = () => {
    const row = heldRow() ?? rows()[0];
    if (row) occupy(row);
  };
  const leaveDiff = () => {
    if (!railShown && !railPeek) return setRailPeek(true);
    seatRow();
  };
  useEffect(() => { if (railPeek) seatRow(); }, [railPeek]);
  const shown = () => Boolean(body.current?.checkVisibility());
  // Ctrl+Shift+l opens the held row's comparison in the editor; Ctrl+Shift+h lands the keys back on the list.
  useEffect(() => {
    const backToRail = context.global.subscribe('git:focus-rail', () => { if (shown()) leaveDiff(); });
    const intoDiff = context.global.subscribe('git:focus-diff', () => { if (shown()) into(); });
    const openFile = context.global.subscribe('git:open-file', () => { if (shown()) openHeldFile(); });
    return () => { backToRail(); intoDiff(); openFile(); };
  }, [context, railShown, railPeek]);
  // The rail answers the keys the way a vim list does. The width handle reads its own keys, so a press made in it is
  // not a press for the rail.
  useEffect(() => {
    const panel = body.current?.closest<HTMLElement>('.sidebar-panel');
    if (!panel) return;
    const regain = () => {
      const patch = lastPane === 'patch' ? panel.querySelector<HTMLElement>('.git-diff') : null;
      if (patch) patch.focus(); else seatRow();
    };
    const notePane = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.git-diff')) lastPane = 'patch';
      else if (target.closest('.git-rail')) lastPane = 'history';
    };
    panel.addEventListener('wangcai:shown', regain);
    panel.addEventListener('focusin', notePane);
    const unbind = bindKeys(panel, [
      { keys: 'j', run: () => step(1) },
      { keys: '<Down>', run: () => step(1) },
      { keys: 'k', run: () => step(-1) },
      { keys: '<Up>', run: () => step(-1) },
      { keys: 'G', run: () => jump('last') },
      { keys: 'gg', run: () => jump('first') },
      { keys: 'l', run: into },
      { keys: '<Right>', run: into },
      { keys: '<Enter>', run: into },
      { keys: 'h', run: out },
      { keys: '<Left>', run: out },
    ], {
      ignore: (event) => pressIn(event, '.git-divider') || pressIn(event, '.git-diff'),
    });
    return () => { panel.removeEventListener('wangcai:shown', regain); panel.removeEventListener('focusin', notePane); unbind(); };
  });
  return <section className="git-page" aria-label="Git history">
    <header className="git-toolbar">
      <span className="git-branch" title={overview?.upstream}>{overview?.branch}
        {overview?.ahead ? <b> ↑{overview.ahead}</b> : null}{overview?.behind ? <i> ↓{overview.behind}</i> : null}</span>
      <span className="git-spacer" />
      <button className="git-icon" aria-label="切换 Git 列表" aria-pressed={railShown} onClick={() => { setRailPeek(false); writeLayout({ railShown: !railShown }); }}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM6 3.5v9"/></svg>
      </button>
      <button className="git-icon" aria-label="刷新 Git" disabled={loading} onClick={() => setToolbarRead(value => value + 1)}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.8 6.2A5 5 0 1 0 13 9"/><path d="M13.2 3v3.4h-3.4"/></svg>
      </button>
    </header>
    {error ? <div className="git-note" role="alert">{error}</div> : !overview ? <div className="git-note">正在读取 Git…</div>
      : <div className="git-body" ref={body} data-rail={railShown ? 'shown' : 'hidden'} data-peek={railPeek ? '' : undefined} style={{ '--rail-width': `${railWidth}px` } as CSSProperties}>
        <div className="git-rail-wrap">
          <nav className="git-rail" aria-label="Git 改动与历史" onScroll={endReached} onWheel={endReached}
            onClick={(event) => {
              const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
              if (row) occupy(row);
            }}>
            {!overview.changes.length && <div className="git-note">工作区干净</div>}
            {(Object.entries(stages) as [Stage, string][]).map(([stage, label]) => {
              const files = overview.changes.filter(file => file.stage === stage);
              const row = rowKey.stage(stage);
              return files.length > 0 && <details key={stage} data-stage={stage} open={!folded.includes(stage)}
                onToggle={(event) => foldTo(event.currentTarget, !event.currentTarget.open)}>
                <summary data-row={row} data-cursor={mark(cursor, row)}>{label} <small>{files.length}</small></summary>
                {files.map(file => <FileRow key={file.path} file={file} row={rowKey.change(stage, file.path)} cursor={cursor} select={() => show({ ...file, source: stage })} />)}
              </details>;
            })}
            {overview.truncated && <div className="git-note">仅显示前 1000 项改动</div>}
            <div className="git-gap" />
            <div className="git-history">
              {overview.commits.map(commit => <CommitRow key={`${overview.root}:${commit.sha}`} commit={commit} context={context} terminal={terminal} root={overview.root}
                cursor={cursor} selected={opened === commit.sha} toggle={() => setOpened(opened === commit.sha ? null : commit.sha)} select={show} />)}
              {!overview.commits.length && <div className="git-note">暂无提交</div>}
            </div>
          </nav>
          <div className="git-divider" role="separator" aria-orientation="vertical" aria-label="调整 Git 列表宽度" tabIndex={0}
            aria-valuenow={railWidth} aria-valuemin={railMinimum} aria-valuemax={railMaximum}
            onPointerDown={(event) => { event.preventDefault(); drag.current = { origin: event.clientX, width: railWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => { if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) writeLayout({ railWidth: clampWidth(drag.current.width + event.clientX - drag.current.origin) }); }}
            onPointerUp={(event) => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
            onKeyDown={(event) => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); writeLayout({ railWidth: clampWidth(railWidth + (event.key === 'ArrowRight' ? 20 : -20)) }); }} />
        </div>
        <div className="git-board">
          {comparison
            ? <DiffPreview context={context} terminal={terminal} root={overview.root} comparison={comparison} />
            : <div className="git-note">选择文件查看改动，点击改动处跳转到文件</div>}
        </div>
      </div>}
  </section>;
}

function GitView({ context, activation, workspaceId, autoRefresh }: { context: UiContext; activation: number; workspaceId?: string; autoRefresh: boolean }) {
  const [terminal, setTerminal] = useState<WorkspaceActive | null>(null);
  useEffect(() => {
    const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      setTerminal(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
    });
    void context.global.publish('workspace:query', null);
    return off;
  }, [context, activation, workspaceId]);
  if (!terminal) return <div className="git-note">请选择一个已连接的终端</div>;
  // The page follows a session, not everything the workspace reports about it: a shell that retitles its workspace
  // does not move the page to another one.
  const session = `${terminal.machine.id}|${terminal.machine.host ?? ''}|${terminal.sessionId}`;
  return <Repository key={session} context={context} terminal={terminal} activation={activation} autoRefresh={autoRefresh} />;
}

export function open(context: UiContext, record?: TabRecord) {
  const workspaceId = record?.workspaceId ?? activeWorkspaceId;
  const profile: Settings = context.host.config;
  context.host.tabs({ id: 'history', title: 'Git', workspaceId, mount(container: HTMLElement) {
    container.style.fontFamily = font.family;
    const root = createRoot(container);
    let activation = 0;
    return { onSelect: () => root.render(<GitView context={context} activation={++activation} workspaceId={workspaceId} autoRefresh={profile.autoRefresh} />), dispose: () => root.unmount() };
  } });
}

export async function mount(_container: HTMLElement, context: UiContext) {
  const profile: Settings = context.host.config;
  font = profile.font;
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => { activeWorkspaceId = value?.workspaceId; });
  void context.global.publish('workspace:query', null);
  return () => { offActive(); };
}
