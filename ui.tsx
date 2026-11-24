import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, RefObject, UIEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ChangeSet, Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, lineNumbers } from '@codemirror/view';
import { MergeView, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
import { editorTheme } from './theme';
import { modeFor } from './mode';
import type { FileClick, Theme, WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { bindKeys, pressIn } from '@lengmoxxl/sdk/keys';
import type { Commit, Comparison, Diff, Font, GitFile, History, Overview, Settings, Stage } from './shared';
import './style.css';

export const title = 'Git';
let font: Font;
let theme: Theme;
let bus: UiContext['global'];
let activeWorkspaceId: string | undefined;
const stages: Record<Stage, string> = { conflicted: '冲突', staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' };
const readingOrder = ['auto', 'split', 'inline'] as const;
type Reading = typeof readingOrder[number];
const readings: Record<Reading, string> = { auto: '自动', split: '双栏', inline: '单栏' };
// The page's layout is a habit of the reader rather than of a repository, so one store holds it for every workspace: a
// width, a reading mode or a folded section changed in one Git tab is drawn by the others as well, and outlives them.
type PageLayout = { reading: Reading; wrap: boolean; railShown: boolean; railWidth: number; folded: Stage[] };
const layoutDefaults: PageLayout = { reading: 'auto', wrap: true, railShown: true, railWidth: 260, folded: [] };
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


// Where the caret sits in the diff: the line and column the toolbar hands the file it opens, and the point the editor
// puts it back at when a note gives way to the diff again.
type Caret = { line: number; column: number };

// How a press reaches the diff: a comparison the pane already shows hands the keys to the editor it holds, and any other
// arrives as `take`, which the pane mounting for it spends. Both end in `enter`, which is what Ctrl+Shift+l calls.
type Keys = { take?: Comparison; enter?: () => void };
type Jump = { next: () => void; previous: () => void };

function DiffEditor({ diff, path, reading, wrap, caret, keys, jumps, changes }: {
  diff: Diff; path: string; reading: Reading; wrap: boolean; caret: RefObject<Caret | undefined>;
  keys: RefObject<Keys>; jumps: RefObject<Jump | undefined>; changes: (count: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const held = useRef<{ side: EditorView; write: (oldText: string, newText: string) => void; count: () => number; rewrap: (on: boolean) => void; reveal: () => void; destroy: () => void; now: (state?: EditorState) => { line: number; column: number }; seat: (line: number, column: number) => number }>(undefined);
  // Auto reading draws the inline view while the pane is narrow, the same 900px breakpoint the diff drew with before.
  const [narrow, setNarrow] = useState(false);
  const unified = reading === 'inline' || (reading === 'auto' && narrow);
  const keptScroll = useRef(0);
  const keptFocus = useRef(false);
  useEffect(() => {
    const host = element.current!;
    const sized = new ResizeObserver(() => setNarrow(host.clientWidth < 900));
    sized.observe(host);
    return () => sized.disconnect();
  }, []);
  useEffect(() => {
    const host = element.current!;
    const colours = new Compartment();
    const wrapping = new Compartment();
    const common = [
      colours.of(editorTheme(theme, font)),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      lineNumbers(), drawSelection(), EditorState.readOnly.of(true), modeFor(path),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet) caret.current = now(update.state);
      }),
    ];
    // The smallest edit that turns one text into the other, so a read only rewrites the span that changed.
    const edit = (before: string, text: string) => {
      if (before === text) return undefined;
      const shortest = Math.min(before.length, text.length);
      let head = 0;
      while (head < shortest && before[head] === text[head]) head++;
      let tail = 0;
      while (tail < shortest - head && before[before.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
      return { from: head, to: before.length - tail, insert: text.slice(head, text.length - tail) };
    };
    let side: EditorView, scroller: HTMLElement, views: EditorView[], count: () => number,
      write: (oldText: string, newText: string) => void, destroy: () => void;
    if (unified) {
      const view = new EditorView({
        state: EditorState.create({ doc: diff.newText, extensions: [...common, unifiedMergeView({ original: diff.oldText, mergeControls: false, gutter: false })] }),
        parent: host,
      });
      side = view; scroller = view.scrollDOM; views = [view];
      count = () => getChunks(view.state)?.chunks.length ?? 0;
      write = (oldText, newText) => {
        const after = edit(view.state.doc.toString(), newText);
        const original = getOriginalDoc(view.state).toString();
        const before = edit(original, oldText);
        if (!after && !before) return;
        view.dispatch({ changes: after, effects: before ? originalDocChangeEffect(view.state, ChangeSet.of(before, original.length)) : [] });
      };
      destroy = () => view.destroy();
    } else {
      const view = new MergeView({
        a: { doc: diff.oldText, extensions: common },
        b: { doc: diff.newText, extensions: common },
        parent: host, gutter: false,
      });
      side = view.b; scroller = view.dom; views = [view.a, view.b];
      count = () => view.chunks.length;
      write = (oldText, newText) => {
        const before = edit(view.a.state.doc.toString(), oldText);
        const after = edit(view.b.state.doc.toString(), newText);
        if (before) view.a.dispatch({ changes: before });
        if (after) view.b.dispatch({ changes: after });
      };
      destroy = () => view.destroy();
    }
    const rewrap = (on: boolean) => { for (const view of views) view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) }); };
    const offTheme = bus.subscribe<Theme>('theme', (next) => { for (const view of views) view.dispatch({ effects: colours.reconfigure(editorTheme(next, font)) }); });
    scroller.scrollTop = keptScroll.current;
    const lineHeight = side.defaultLineHeight;
    const seat = (line: number, column: number) => {
      const at = side.state.doc.line(Math.min(side.state.doc.lines, Math.max(1, line)));
      return Math.min(at.to, at.from + Math.max(0, column - 1));
    };
    const now = (state: EditorState = side.state) => {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      return { line: line.number, column: head - line.from + 1 };
    };
    // The caret is revealed at the centre only when the scroll no longer shows it.
    const reveal = () => {
      const head = side.state.selection.main.head;
      const coords = side.coordsAtPos(head);
      const box = scroller.getBoundingClientRect();
      if (!coords || coords.top < box.top || coords.bottom > box.bottom) side.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) });
    };
    const go = (line: number) => { side.dispatch({ selection: { anchor: seat(line, 1) } }); reveal(); };
    const column = (value: number) => { side.dispatch({ selection: { anchor: seat(now().line, value) } }); };
    const screenful = () => Math.max(1, Math.floor(scroller.clientHeight / lineHeight) - 1);
    const scroll = (lines: number) => { scroller.scrollTop += lines * lineHeight; go(now().line + lines); };
    if (caret.current) {
      const at = seat(caret.current.line, caret.current.column);
      side.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    }
    jumps.current = { next: () => { goToNextChunk(side); }, previous: () => { goToPreviousChunk(side); } };
    changes(count());
    // A count typed before a key makes that key's motion run that many times, as vim reads one, and the press that reads
    // it spends it: a count only ever reaches the key it was typed for.
    let typed = 0;
    const counted = (run: (times: number) => void) => () => { const times = typed || 1; typed = 0; run(times); };
    const digit = (value: number) => { typed = typed * 10 + value; };
    // A key that takes no count spends one all the same, so digits left waiting do not walk the key after them.
    const plain = (run: () => void) => counted(() => run());
    const lineStart = () => column(1);
    const lineEnd = () => { side.dispatch({ selection: { anchor: side.state.doc.lineAt(side.state.selection.main.head).to } }); };
    // The keys a vim reader reaches for in a read-only diff.
    const down = counted(times => go(now().line + times));
    const up = counted(times => go(now().line - times));
    const left = plain(() => column(now().column - 1));
    const right = plain(() => column(now().column + 1));
    // vim's own ]c and [c walk one change, or as many as a count asks for.
    const walk = (direction: 'next' | 'previous') => counted(times => {
      for (let at = 0; at < times; at += 1) jumps.current?.[direction]();
    });
    const unbind = bindKeys(host, [
      { keys: '<C-d>', run: plain(() => scroll(Math.round(screenful() / 2))) },
      { keys: '<C-u>', run: plain(() => scroll(-Math.round(screenful() / 2))) },
      { keys: '<C-f>', run: plain(() => scroll(screenful())) },
      { keys: '<C-b>', run: plain(() => scroll(-screenful())) },
      // The digits that make a count; `0` is one only once a count is under way, since alone it names the line's start.
      ...'123456789'.split('').map((key) => ({ keys: key, run: () => digit(Number(key)) })),
      { keys: '0', run: () => { if (typed) digit(0); else lineStart(); } },
      { keys: 'j', run: down },
      { keys: '<Down>', run: down },
      { keys: 'k', run: up },
      { keys: '<Up>', run: up },
      { keys: 'h', run: left },
      { keys: '<Left>', run: left },
      { keys: 'l', run: right },
      { keys: '<Right>', run: right },
      { keys: '<Home>', run: plain(lineStart) },
      { keys: '$', run: plain(lineEnd) },
      { keys: '<End>', run: plain(lineEnd) },
      { keys: 'G', run: plain(() => go(side.state.doc.lines)) },
      { keys: 'gg', run: plain(() => go(1)) },
      { keys: ']c', run: walk('next') },
      { keys: '[c', run: walk('previous') },
    ], { fields: 'all' });
    // A key held down repeats, and the table drops every repeat so that a prefix like `gg` is not entered twice by one
    // hold; the two line motions read their own repeats here, which is what keeps the caret walking while j or k is down.
    const motions: Record<string, () => void> = { j: down, k: up };
    const repeated = (event: KeyboardEvent) => {
      if (!event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const motion = motions[event.key];
      if (!motion) return;
      event.preventDefault();
      motion();
    };
    host.addEventListener('keydown', repeated, true);
    keys.current.enter = () => side.focus();
    // A rebuild into the other reading mode must not drop the focus the keys were just handed.
    if (keptFocus.current) side.focus();
    held.current = { side, write, count, rewrap, reveal, destroy, now, seat };
    return () => {
      keptScroll.current = scroller.scrollTop;
      keptFocus.current = side.hasFocus;
      keys.current.enter = undefined; jumps.current = undefined;
      host.removeEventListener('keydown', repeated, true); unbind(); offTheme();
      destroy(); held.current = undefined;
    };
  }, [path, unified]);
  // A read of the file the pane already shows rewrites the sides where they stand: only the span that changed is edited,
  // so the caret and the scroll it was left at survive unless that scroll no longer shows the caret.
  useEffect(() => {
    const pane = held.current;
    if (!pane) return;
    const at = pane.now();
    pane.write(diff.oldText, diff.newText);
    // A read that rewrites the span the caret sits in maps it to the edit's edge, so it is seated back where it was.
    const pos = pane.seat(at.line, at.column);
    if (pane.side.state.selection.main.head !== pos) pane.side.dispatch({ selection: { anchor: pos } });
    changes(pane.count());
    pane.reveal();
  }, [diff]);
  useEffect(() => { held.current?.rewrap(wrap); }, [wrap]);
  return <div className="git-editor" ref={element} />;
}

const watch = (context: UiContext, terminal: WorkspaceActive, holder: string, paths: string[], act: () => void) => {
  // The plugin can be disposed before either request lands, and the machine can be gone; neither is worth a pageerror.
  void context.ui.request('watch', { holder, machine: terminal.machine, paths }).catch(() => undefined);
  const off = context.ui.subscribe<string>('changed', (path) => { if (paths.includes(path)) act(); });
  return () => { off(); void context.ui.request('watch', { holder, machine: terminal.machine, paths: [] }).catch(() => undefined); };
};

// A repository root and a path inside it, as the machine's absolute path: '/' is the one root that adds nothing.
const absolute = (root: string, path: string) => `${root === '/' ? '' : root}/${path}`;

// What tells one diff pane from another: a comparison drawn again is the same pane, so it keeps its editor.
const paneKey = (comparison: Comparison) => JSON.stringify(comparison);

// What a pane reads its diff from, as the repository names it: a change carries the blobs of the two sides its own
// diff reads, and the worktree side is the file the pane watches. Two things it cannot name: a file the list does not
// hold, and a file a truncated list cut off, for which the key is the number of reads the page has applied.
const sides = (comparison: Comparison, overview: Overview, appliedReads: number) => {
  // A commit names its content by its id alone.
  if (comparison.source === 'commit') return 'commit';
  const change = overview.changes.find(file => file.stage === comparison.source && file.path === comparison.path);
  if (change) return [change.status, change.oldPath, change.headBlob, change.indexBlob].join('\0');
  return overview.truncated ? `cut\0${appliedReads}` : 'gone';
};

function DiffPane({ context, terminal, holder, root, comparison, reading, wrap, source, caret, keys, jumps, changes }: {
  context: UiContext; terminal: WorkspaceActive; holder: string; root: string; comparison: Comparison; reading: Reading; wrap: boolean; source: string; caret: RefObject<Caret | undefined>; keys: RefObject<Keys>; jumps: RefObject<Jump | undefined>; changes: (count: number) => void;
}) {
  const [diff, setDiff] = useState<Diff>();
  const [error, setError] = useState('');
  const forced = useRef(false);
  // The pane reads what it shows when it opens, and again when the sides it compares are not the ones it holds, or
  // where a truncated list cut its file off so that no read can name those sides, whenever the page applies a read.
  // Otherwise a change elsewhere in the repository leaves the pane as it is.
  const read = () => {
    void context.ui.request<Diff>('diff', { terminal, root, comparison, force: forced.current }).then(value => {
      setError('');
      // A read that finds what the pane already holds leaves it as it is, so a poll of an unchanged file draws nothing.
      setDiff(previous => previous && previous.oldText === value.oldText && previous.newText === value.newText
        && previous.notice === value.notice && previous.tooLarge === value.tooLarge ? previous : value);
    }).catch((problem: Error) => setError(problem.message));
  };
  useEffect(read, [context, terminal, root, comparison, source]);
  // Writing the file changes what the pane holds while the repository stays as it is, so that file is watched: what a
  // commit or the index holds is not the machine's file, and a deleted file has nothing to watch. A watch that cannot
  // be registered leaves that side to the reads the whole page asks for.
  useEffect(() => {
    const inWorktree = ['unstaged', 'untracked', 'conflicted'].includes(comparison.source) && comparison.status !== 'D';
    return inWorktree ? watch(context, terminal, holder, [absolute(root, comparison.path)], read) : undefined;
  }, [context, terminal, holder, root, comparison]);
  // The keys a press leaves name the comparison this pane mounts for, and the pane spends them once it settles: the
  // editor that mounted takes them, and a file with only a note or a failed read has none to take.
  useEffect(() => {
    if (keys.current.take !== comparison || (!error && !diff)) return;
    keys.current.take = undefined;
    keys.current.enter?.();
  }, [keys, comparison, error, diff]);
  if (error) return <div className="git-note" role="alert">{error}</div>;
  if (!diff) return <div className="git-note">正在读取 diff…</div>;
  if (diff.tooLarge !== undefined) return (
    <div className="git-note">
      <div>文件较大（{(diff.tooLarge / 1024 / 1024).toFixed(1)} MiB），加载可能卡顿。</div>
      <button onClick={() => { forced.current = true; read(); }}>仍要加载</button>
    </div>
  );
  if (diff.notice) return <div className="git-note">{diff.notice}</div>;
  return <DiffEditor diff={diff} path={comparison.path} reading={reading} wrap={wrap} caret={caret} keys={keys} jumps={jumps} changes={changes} />;
}

function FileRow({ file, row, cursor, select }: { file: GitFile; row: string; cursor: string; select: () => void }) {
  const cut = file.path.lastIndexOf('/');
  return <button className="git-file" data-row={row} data-cursor={mark(cursor, row)} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={select}>
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

function Repository({ context, terminal, holder, activation, autoRefresh }: { context: UiContext; terminal: WorkspaceActive; holder: string; activation: number; autoRefresh: boolean }) {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const [toolbarRead, setToolbarRead] = useState(0);
  const [pageReads, setPageReads] = useState(0);
  const [appliedReads, setAppliedReads] = useState(0);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Comparison>();
  const { reading, wrap, railShown, railWidth, folded } = useSyncExternalStore(watchLayout, readLayout);
  // Whether the keys slid the hidden list out, as the pointer does: the slide goes away with the file it chose.
  const [railPeek, setRailPeek] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  // The row the rail's keys hold, named by the row's own key, so a read that redraws the list leaves it on that row.
  const [cursor, setCursor] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ origin: number; width: number }>(undefined);
  const caret = useRef<Caret>(undefined);
  const keys = useRef<Keys>({});
  const diffHeld = useRef(false);
  const jumps = useRef<Jump>(undefined);
  const [blocks, setBlocks] = useState(0);
  // Set while a press opens a file: it makes that choice the one the keys wait for, and it is what tells a press on the
  // diff the pane already shows apart from a click on the same row.
  const pressing = useRef(false);
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
        if (repositoryRoot.current !== value.root) { setComparison(undefined); setOpened(value.commits[0]?.sha ?? null); }
        repositoryRoot.current = value.root;
        setOverview(value);
        // A change the list no longer holds has nothing left to compare, so the pane that showed it closes instead of
        // reading a diff of a change the repository no longer has; a truncated list cannot say whether its file left.
        setComparison(previous => previous && sides(previous, value, appliedReads) === 'gone' ? undefined : previous);
        setAppliedReads(count => count + 1);
        setError('');
      }).catch((error: Error) => {
        if (current !== generation.current) return;
        // A read that failed has nothing to compare against, so the page is drawn again by the read that works.
        lastRead.current = '';
        setOverview(undefined); setComparison(undefined); setError(error.message);
      })
        .finally(() => {
          busy.current = false;
          if (forced && current === generation.current) setLoading(false);
        });
    };
    read(true);
    // A read of the whole page, the button's or the tab's, reads what the pane shows again as well.
    setPageReads(count => count + 1);
    const timer = autoRefresh ? setInterval(() => read(false), pollMilliseconds) : undefined;
    return () => { clearInterval(timer); generation.current++; };
  }, [context, terminal, toolbarRead, activation, autoRefresh]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.git-menu')) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(undefined); };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', dismiss); window.removeEventListener('keydown', escape); };
  }, [menu]);
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
  // The row the keys hold takes the focus with the cursor, so a press that folds a section or leaves the diff lands on
  // something the keys read.
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
  // Choosing a file from the rail: the pane it opens, and the keys the choice hands over.
  // A file chosen out of the keys' own slide closes it, so the diff shows the board the reader left.
  const show = (next: Comparison) => {
    setRailPeek(false);
    const fromPress = pressing.current;
    pressing.current = false;
    // The pane mounts per comparison, so a file it already shows settles nowhere and no render would spend the keys: a
    // press hands them to the editor it holds. That press still seats the row it was made on, so the hand-off waits for
    // it to finish, or the row would take the focus back; a click on the row hands nothing over.
    if (comparison && paneKey(comparison) === paneKey(next)) {
      if (fromPress) queueMicrotask(() => keys.current.enter?.());
      return;
    }
    // A caret belongs to the diff that holds it, so another file forgets the one the last file was left at.
    caret.current = undefined;
    setBlocks(0);
    if (fromPress) keys.current.take = next;
    setComparison(next);
  };
  const into = () => {
    const row = heldRow();
    if (!row) return;
    // The press is the row's own: it toggles a section or a commit's files, and a file's diff opens with the keys, which
    // `pressing` marks as this press's own.
    if (row.classList.contains('git-file')) pressing.current = true;
    row.click();
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
    if (commit) commit.click();
    else if (row.getAttribute('aria-expanded') === 'true') row.click();
  };
  // The row the keys land on when they come back to the list: the one they were on, or the list's top.
  const seatRow = () => {
    const row = heldRow() ?? rows()[0];
    if (row) occupy(row);
  };
  // The diff hands the keys back to the list. One the toolbar hid slides out over the board the way the pointer brings
  // it, and its row is seated once the page has drawn that slide; choosing a file takes the slide away again.
  const leaveDiff = () => {
    if (!railShown && !railPeek) return setRailPeek(true);
    seatRow();
  };
  useEffect(() => { if (railPeek) seatRow(); }, [railPeek]);
  // The file the toolbar opens and `<leader>gf` opens: the click a view of its own then shows, at the caret it shows it at.
  const openFile = () => {
    if (!overview || !comparison || comparison.status === 'D') return;
    void context.global.publish('onclick', {
      type: 'file', machine: terminal.machine,
      path: absolute(overview.root, comparison.path),
      line: caret.current?.line, column: caret.current?.column,
    } satisfies FileClick).catch((error: Error) => setError(error.message));
  };
  const shown = () => Boolean(body.current?.checkVisibility());
  // The window matches the leader before any page hears it, so the key arrives as an event: every mounted tab is told,
  // and the one on show is the one that answers.
  useEffect(() => context.global.subscribe('git:open-file', () => { if (shown()) openFile(); }),
    [context, terminal, overview, comparison]);
  // The keys go to the pane the press names: the rail hands them to the diff, and the diff hands them back. A page that
  // is not on show leaves the press alone, since the tabs of other workspaces hear it too; the press reads the two
  // states the list is drawn by, so a press after a toggle sees them as they now are.
  useEffect(() => {
    const backToRail = context.global.subscribe('git:focus-rail', () => { if (shown()) leaveDiff(); });
    const intoDiff = context.global.subscribe('git:focus-diff', () => { if (!shown()) return; setRailPeek(false); keys.current.enter?.(); });
    return () => { backToRail(); intoDiff(); };
  }, [context, railShown, railPeek]);
  // The rail answers the keys the way a vim list does. The diff and the width handle read their own keys, so a press made
  // in either is not a press for the rail.
  useEffect(() => {
    const panel = body.current?.closest<HTMLElement>('.sidebar-panel');
    if (!panel) return;
    const down = () => step(1);
    const up = () => step(-1);
    // The view the focus lands in is the one a shown page hands the keys back to; the diff's editor retargets its
    // focus to its host across the shadow boundary, the rail's rows answer for themselves.
    const held = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.git-editor')) diffHeld.current = true;
      else if (target.closest('.git-rail')) diffHeld.current = false;
    };
    panel.addEventListener('focusin', held);
    // The window hands this page its keys when its tab comes to the front, by the core's walk or a click on the tab;
    // they return to the view that held them last, and to the rail when neither has.
    const regain = () => {
      if (diffHeld.current && keys.current.enter) { setRailPeek(false); keys.current.enter(); }
      else leaveDiff();
    };
    panel.addEventListener('wangcai:shown', regain);
    const unbind = bindKeys(panel, [
      { keys: 'j', run: down },
      { keys: '<Down>', run: down },
      { keys: 'k', run: up },
      { keys: '<Up>', run: up },
      { keys: 'G', run: () => jump('last') },
      { keys: 'gg', run: () => jump('first') },
      { keys: 'l', run: into },
      { keys: '<Right>', run: into },
      { keys: '<Enter>', run: into },
      { keys: 'h', run: out },
      { keys: '<Left>', run: out },
    ], {
      ignore: (event) => pressIn(event, '.git-editor, .git-divider'),
    });
    return () => { panel.removeEventListener('wangcai:shown', regain); panel.removeEventListener('focusin', held); unbind(); };
  });
  return <section className="git-page" aria-label="Git history" data-reading={reading}>
    <header className="git-toolbar">
      <span className="git-branch" title={overview?.upstream}>{overview?.branch}
        {overview?.ahead ? <b> ↑{overview.ahead}</b> : null}{overview?.behind ? <i> ↓{overview.behind}</i> : null}</span>
      <span className="git-spacer" />
      <button className="git-icon" aria-label="切换 Git 列表" aria-pressed={railShown} onClick={() => { setRailPeek(false); writeLayout({ railShown: !railShown }); }}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM6 3.5v9"/></svg>
      </button>
      <button className="git-icon" aria-label={`阅读方式 ${readings[reading]}`} title={`阅读方式：${readings[reading]}（点击切换）`}
        onClick={() => writeLayout({ reading: readingOrder[(readingOrder.indexOf(reading) + 1) % readingOrder.length] })}>
        <svg className="git-icon-auto" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11z"/><path d="M8 3.5v9" strokeDasharray="2 2"/></svg>
        <svg className="git-icon-split" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM8 3.5v9"/></svg>
        <svg className="git-icon-inline" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM4.5 6.5h7M4.5 9.5h4"/></svg>
      </button>
      <button className="git-icon" aria-label="长行折行" aria-pressed={wrap} onClick={() => writeLayout({ wrap: !wrap })}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h8a2 2 0 1 1 0 4H8M2.5 12h3"/><path d="M9.4 10.6 8 12l1.4 1.4"/></svg>
      </button>
      <button className="git-icon" aria-label="打开文件" title={comparison?.status === 'D' ? '文件已删除' : '打开文件（工作区版本）'}
        disabled={!overview || !comparison || comparison.status === 'D'} onClick={openFile}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 13.5H2.5v-11h5l3 3V7M7.5 2.5v3h3M7 10h7m-3-3 3 3-3 3"/></svg>
      </button>
      <button className="git-icon" aria-label="上一处改动" title="上一处改动（[c）" disabled={!comparison || !blocks}
        onClick={() => jumps.current?.previous()}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5 3.5 8M8 3.5 12.5 8M8 3.5v9"/></svg>
      </button>
      <button className="git-icon" aria-label="下一处改动" title="下一处改动（]c）" disabled={!comparison || !blocks}
        onClick={() => jumps.current?.next()}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5 3.5 8M8 12.5 12.5 8M8 12.5v-9"/></svg>
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
          {comparison ? <section className="git-pane" aria-label={`Diff ${comparison.path}`}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
            <DiffPane key={paneKey(comparison)} context={context} terminal={terminal} holder={holder} root={overview.root} comparison={comparison} reading={reading} wrap={wrap} caret={caret} keys={keys} jumps={jumps} changes={setBlocks} source={`${pageReads}:${sides(comparison, overview, appliedReads)}`} />
          </section> : <div className="git-note">选择文件查看 diff</div>}
        </div>
      </div>}
    {menu && <div className="git-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button role="menuitem" onClick={() => { setComparison(undefined); setMenu(undefined); }}>关闭</button>
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
  // does not move the page to another one, and rebuilding it would take the diff and its caret off the screen.
  const session = `${terminal.machine.id}|${terminal.machine.host ?? ''}|${terminal.sessionId}`;
  return <Repository key={session} context={context} terminal={terminal} activation={activation} holder={workspaceId ?? ''} autoRefresh={autoRefresh} />;
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
  theme = profile.theme;

  bus = context.global;
  // The colours live in the extensions each view was built with, so a switch of theme is read by the views already on
  // screen through their own subscription; this keeps the palette a view built next starts from.
  const offTheme = context.global.subscribe<Theme>('theme', (next) => { theme = next; });
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => { activeWorkspaceId = value?.workspaceId; });
  void context.global.publish('workspace:query', null);
  return () => { offActive(); offTheme(); };
}
