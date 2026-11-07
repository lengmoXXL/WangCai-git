import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject, UIEvent } from 'react';
import { createRoot } from 'react-dom/client';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/codicon/register.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import type { FileClick, Theme, WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { bindKeys, pressIn } from '@lengmoxxl/sdk/keys';
import type { Commit, Comparison, Diff, Font, GitFile, History, Overview, Settings, Stage } from './shared';
import './style.css';

export const title = 'Git';
let font: Font;
let activeWorkspaceId: string | undefined;
const stages: Record<Stage, string> = { conflicted: '冲突', staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' };
const readingOrder = ['auto', 'split', 'inline'] as const;
type Reading = typeof readingOrder[number];
const readings: Record<Reading, string> = { auto: '自动', split: '双栏', inline: '单栏' };

// A rail row is named by the key the cursor holds: the kind of row, then whatever names it.
const rowKey = {
  stage: (stage: Stage) => `stage:${stage}`,
  change: (stage: Stage, path: string) => `change:${stage}:${path}`,
  commit: (sha: string) => `commit:${sha}`,
  commitFile: (sha: string, path: string) => `commitfile:${sha}:${path}`,
};

// The mark a row draws while the keys hold it: an empty value the walk reads back off the page.
const mark = (cursor: string, row: string) => cursor === row ? '' : undefined;

function editorTheme(theme: Theme): monaco.editor.IStandaloneThemeData {
  const hex = (color: string) => color.slice(1);
  const alpha = (color: string, value: number) => `${color}${Math.round(value * 255).toString(16).padStart(2, '0')}`;
  return {
    base: getComputedStyle(document.documentElement).colorScheme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: hex(theme.muted) },
      { token: 'string', foreground: hex(theme.green) },
      { token: 'number', foreground: hex(theme.yellow) },
      { token: 'keyword', foreground: hex(theme.magenta) },
      { token: 'type', foreground: hex(theme.cyan) },
      { token: 'function', foreground: hex(theme.blue) },
      { token: 'constant', foreground: hex(theme.brightMagenta) },
      { token: 'delimiter', foreground: hex(theme.muted) },
      { token: 'regexp', foreground: hex(theme.red) },
    ],
    colors: {
      'editor.background': theme.background,
      'editor.foreground': theme.foreground,
      'editorLineNumber.foreground': theme.muted,
      'editorCursor.foreground': theme.cursor,
      'editor.selectionBackground': theme.selection,
      'editorWidget.background': theme.overlay,
      'editorWidget.border': theme.border,
      'editorGutter.background': theme.background,
      'editorBracketHighlight.foreground1': theme.foreground,
      'editorBracketHighlight.foreground2': theme.foreground,
      'editorBracketHighlight.foreground3': theme.foreground,
      'diffEditor.insertedTextBackground': alpha(theme.green, 0.2),
      'diffEditor.removedTextBackground': alpha(theme.red, 0.2),
      'diffEditor.insertedLineBackground': alpha(theme.green, 0.08),
      'diffEditor.removedLineBackground': alpha(theme.red, 0.08),
      'scrollbarSlider.background': alpha(theme.muted, 0.25),
      'scrollbarSlider.hoverBackground': alpha(theme.muted, 0.4),
      'scrollbarSlider.activeBackground': alpha(theme.muted, 0.5),
    },
  };
}

// Where the caret sits in the diff: the line and column the toolbar hands the file it opens, and the point the editor
// puts it back at when a note gives way to the diff again.
type Caret = { line: number; column: number };

// How a press reaches the diff: a comparison the pane already shows hands the keys to the editor it holds, and any other
// arrives as `take`, which the pane mounting for it spends. Both end in `enter`, which is what Ctrl+Right calls. The way
// is the `leave` the pane is handed with its comparison.
type Keys = { take?: Comparison; enter?: () => void };
type Jump = { next: () => void; previous: () => void };

function DiffEditor({ diff, path, reading, wrap, caret, keys, jumps, changes, leave }: {
  diff: Diff; path: string; reading: Reading; wrap: boolean; caret: RefObject<Caret | undefined>;
  keys: RefObject<Keys>; jumps: RefObject<Jump | undefined>; changes: (count: number) => void; leave: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor>(undefined);
  const options = {
    renderSideBySide: reading !== 'inline',
    useInlineViewWhenSpaceIsLimited: reading === 'auto',
    wordWrap: wrap ? 'on' : 'off',
  } as const;
  useEffect(() => {
    // Each plugin bundles Monaco; its theme rules must stay inside its own editor.
    const shadow = element.current!.shadowRoot ?? element.current!.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./ui.css', import.meta.url).href;
    const container = document.createElement('div');
    container.style.height = '100%';
    shadow.replaceChildren(stylesheet, container);
    const size = font.size;
    const view = monaco.editor.createDiffEditor(container, {
      theme: 'wangcai', readOnly: true, domReadOnly: true,
      automaticLayout: true, scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      ...options, fontSize: size, lineHeight: font.lineHeight ? Math.round(size * font.lineHeight) : 0, fontFamily: font.family, lineNumbersMinChars: 3, contextmenu: false, cursorStyle: 'block',
    });
    const name = path.split('/').pop()!;
    const language = monaco.languages.getLanguages().find(item => item.filenames?.includes(name) || item.extensions?.some(extension => name.endsWith(extension)))?.id ?? 'plaintext';
    const original = monaco.editor.createModel(diff.oldText, language);
    const modified = monaco.editor.createModel(diff.newText, language);
    view.setModel({ original, modified });
    view.getOriginalEditor().updateOptions({ glyphMargin: false });
    jumps.current = { next: () => view.goToDiff('next'), previous: () => view.goToDiff('previous') };
    // A pane that is set and never edited computes its diff then and there, so the blocks are counted once here as well.
    const count = () => changes(view.getLineChanges()?.length ?? 0);
    const updated = view.onDidUpdateDiff(count);
    count();
    // The caret is taken from the side the diff draws as modified, the side a change leads to.
    const side = view.getModifiedEditor();
    const at = caret.current && { lineNumber: caret.current.line, column: caret.current.column };
    if (at) { side.setPosition(at); side.revealPositionInCenter(at); }
    const moved = side.onDidChangeCursorPosition(({ position }) => { caret.current = { line: position.lineNumber, column: position.column }; });
    // The model the pane draws is the one set above and keeps its text in place, so both it and the line height are read
    // once; the caret and the layout are what the keys have to read fresh.
    const model = side.getModel()!;
    const lineHeight = side.getOption(monaco.editor.EditorOption.lineHeight) || 1;
    const screenful = () => Math.max(1, Math.floor(side.getLayoutInfo().height / lineHeight) - 1);
    const now = () => side.getPosition() ?? { lineNumber: 1, column: 1 };
    const go = (line: number) => {
      const seat = { lineNumber: Math.min(model.getLineCount(), Math.max(1, line)), column: 1 };
      side.setPosition(seat);
      side.revealPositionInCenterIfOutsideViewport(seat);
    };
    const scroll = (lines: number) => { side.setScrollTop(side.getScrollTop() + lines * lineHeight); go(now().lineNumber + lines); };
    const column = (value: number) => {
      const here = now();
      side.setPosition({ lineNumber: here.lineNumber, column: Math.min(model.getLineMaxColumn(here.lineNumber), Math.max(1, value)) });
    };
    const lineDown = () => go(now().lineNumber + 1);
    const lineUp = () => go(now().lineNumber - 1);
    const caretLeft = () => column(now().column - 1);
    const caretRight = () => column(now().column + 1);
    const lineStart = () => column(1);
    const lineEnd = () => column(model.getLineMaxColumn(now().lineNumber));
    // The keys a vim reader reaches for in a read-only diff, kept beside Monaco's own, which keeps every binding this does
    // not read.
    // The keys are bound to the host because that is what a press made inside the shadow tree is retargeted to.
    const unbind = bindKeys(element.current!, [
      { keys: '<C-d>', run: () => scroll(Math.round(screenful() / 2)) },
      { keys: '<C-u>', run: () => scroll(-Math.round(screenful() / 2)) },
      { keys: '<C-f>', run: () => scroll(screenful()) },
      { keys: '<C-b>', run: () => scroll(-screenful()) },
      // The rail is the pane to the left. Ctrl+h belongs to the core, which moves between the workspace list and the
      // page with it, so the arrow is the key that answers here.
      { keys: '<C-Left>', run: leave },
      { keys: 'j', run: lineDown },
      { keys: '<Down>', run: lineDown },
      { keys: 'k', run: lineUp },
      { keys: '<Up>', run: lineUp },
      { keys: 'h', run: caretLeft },
      { keys: '<Left>', run: caretLeft },
      { keys: 'l', run: caretRight },
      { keys: '<Right>', run: caretRight },
      { keys: '0', run: lineStart },
      { keys: '<Home>', run: lineStart },
      { keys: '$', run: lineEnd },
      { keys: '<End>', run: lineEnd },
      { keys: 'G', run: () => go(model.getLineCount()) },
      { keys: 'gg', run: () => go(1) },
      // vim's own ]c and [c walk a change at a time.
      { keys: ']c', run: () => jumps.current?.next() },
      { keys: '[c', run: () => jumps.current?.previous() },
    ], { fields: 'all' });
    keys.current.enter = () => side.focus();
    editor.current = view;
    return () => { keys.current.enter = undefined; jumps.current = undefined; unbind(); updated.dispose(); moved.dispose(); editor.current = undefined; view.dispose(); original.dispose(); modified.dispose(); };
  }, [path]);
  // A read of the file the pane already shows rewrites the two sides where they stand: only the lines that changed
  // redraw, and the caret and the scroll it was left at survive unless that scroll no longer shows the caret.
  // The sides are edited apart rather than set whole: a model set to a new value drops every decoration.
  useEffect(() => {
    const view = editor.current!;
    const models = view.getModel()!;
    if (models.original.getValue() === diff.oldText && models.modified.getValue() === diff.newText) return;
    const write = (model: monaco.editor.ITextModel, text: string) => {
      const before = model.getValue();
      if (before === text) return;
      const shortest = Math.min(before.length, text.length);
      let head = 0;
      while (head < shortest && before[head] === text[head]) head++;
      let tail = 0;
      while (tail < shortest - head && before[before.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
      const from = model.getPositionAt(head);
      const to = model.getPositionAt(before.length - tail);
      model.applyEdits([{ range: monaco.Range.fromPositions(from, to), text: text.slice(head, text.length - tail) }]);
    };
    const kept = view.saveViewState();
    write(models.original, diff.oldText);
    write(models.modified, diff.newText);
    view.restoreViewState(kept);
    const side = view.getModifiedEditor();
    const at = side.getPosition();
    if (at && !side.getVisibleRanges().some((range) => range.containsPosition(at))) side.revealPositionInCenter(at);
  }, [diff]);
  useEffect(() => { editor.current?.updateOptions(options); }, [reading, wrap]);
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

function DiffPane({ context, terminal, holder, root, comparison, reading, wrap, source, caret, keys, jumps, changes, leave }: {
  context: UiContext; terminal: WorkspaceActive; holder: string; root: string; comparison: Comparison; reading: Reading; wrap: boolean; source: string; caret: RefObject<Caret | undefined>; keys: RefObject<Keys>; jumps: RefObject<Jump | undefined>; changes: (count: number) => void; leave: () => void;
}) {
  const [diff, setDiff] = useState<Diff>();
  const [error, setError] = useState('');
  // The pane reads what it shows when it opens, and again when the sides it compares are not the ones it holds, or
  // where a truncated list cut its file off so that no read can name those sides, whenever the page applies a read.
  // Otherwise a change elsewhere in the repository leaves the pane as it is.
  const read = () => {
    void context.ui.request<Diff>('diff', { terminal, root, comparison }).then(value => {
      setError('');
      // A read that finds what the pane already holds leaves it as it is, so a poll of an unchanged file draws nothing.
      setDiff(previous => previous && previous.oldText === value.oldText && previous.newText === value.newText
        && previous.notice === value.notice ? previous : value);
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
  if (diff.notice) return <div className="git-note">{diff.notice}</div>;
  return <DiffEditor diff={diff} path={comparison.path} reading={reading} wrap={wrap} caret={caret} keys={keys} jumps={jumps} changes={changes} leave={leave} />;
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
  const [reading, setReading] = useState<Reading>('auto');
  const [wrap, setWrap] = useState(true);
  const [railShown, setRailShown] = useState(true);
  const [railWidth, setRailWidth] = useState(260);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  // The row the rail's keys hold, named by the row's own key, so a read that redraws the list leaves it on that row.
  const [cursor, setCursor] = useState('');
  // The sections a reader folded, by key or by click; a commit keeps its own fold in `opened`.
  const [folded, setFolded] = useState<Stage[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ origin: number; width: number }>(undefined);
  const caret = useRef<Caret>(undefined);
  const keys = useRef<Keys>({});
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
    setFolded((current) => closed ? (current.includes(stage) ? current : [...current, stage]) : current.filter((one) => one !== stage));
  };
  // Choosing a file from the rail: the pane it opens, and the keys the choice hands over.
  const show = (next: Comparison) => {
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
  // The diff hands the keys back to the row they were on, or to the top of the list when they were on none.
  const leaveDiff = () => {
    const row = heldRow() ?? rows()[0];
    if (row) occupy(row);
  };
  // The rail answers the keys the way a vim list does. The diff and the width handle read their own keys, so a press made
  // in either is not a press for the rail.
  useEffect(() => {
    const panel = body.current?.closest<HTMLElement>('.sidebar-panel');
    if (!panel) return;
    // The diff is the pane to the right, and the arrow hands it the keys: Ctrl+l is the core's own.
    const toDiff = () => keys.current.enter?.();
    const down = () => step(1);
    const up = () => step(-1);
    return bindKeys(panel, [
      { keys: '<C-Right>', run: toDiff },
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
  });
  return <section className="git-page" aria-label="Git history" data-reading={reading}>
    <header className="git-toolbar">
      <span className="git-branch" title={overview?.upstream}>{overview?.branch}
        {overview?.ahead ? <b> ↑{overview.ahead}</b> : null}{overview?.behind ? <i> ↓{overview.behind}</i> : null}</span>
      <span className="git-spacer" />
      <button className="git-icon" aria-label="切换 Git 列表" aria-pressed={railShown} onClick={() => setRailShown(!railShown)}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM6 3.5v9"/></svg>
      </button>
      <button className="git-icon" aria-label={`阅读方式 ${readings[reading]}`} title={`阅读方式：${readings[reading]}（点击切换）`}
        onClick={() => setReading(readingOrder[(readingOrder.indexOf(reading) + 1) % readingOrder.length])}>
        <svg className="git-icon-auto" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11z"/><path d="M8 3.5v9" strokeDasharray="2 2"/></svg>
        <svg className="git-icon-split" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM8 3.5v9"/></svg>
        <svg className="git-icon-inline" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM4.5 6.5h7M4.5 9.5h4"/></svg>
      </button>
      <button className="git-icon" aria-label="长行折行" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h8a2 2 0 1 1 0 4H8M2.5 12h3"/><path d="M9.4 10.6 8 12l1.4 1.4"/></svg>
      </button>
      <button className="git-icon" aria-label="打开文件" title={comparison?.status === 'D' ? '文件已删除' : '打开文件（工作区版本）'}
        disabled={!overview || !comparison || comparison.status === 'D'} onClick={() => void context.global.publish('onclick', {
          type: 'file', machine: terminal.machine,
          path: absolute(overview!.root, comparison!.path),
          line: caret.current?.line, column: caret.current?.column,
        } satisfies FileClick).catch((error: Error) => setError(error.message))}>
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
      : <div className="git-body" ref={body} data-rail={railShown ? 'shown' : 'hidden'} style={{ '--rail-width': `${railWidth}px` } as CSSProperties}>
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
            onPointerMove={(event) => { if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) setRailWidth(clampWidth(drag.current.width + event.clientX - drag.current.origin)); }}
            onPointerUp={(event) => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
            onKeyDown={(event) => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); setRailWidth(clampWidth(railWidth + (event.key === 'ArrowRight' ? 20 : -20))); }} />
        </div>
        <div className="git-board">
          {comparison ? <section className="git-pane" aria-label={`Diff ${comparison.path}`}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
            <DiffPane key={paneKey(comparison)} context={context} terminal={terminal} holder={holder} root={overview.root} comparison={comparison} reading={reading} wrap={wrap} caret={caret} keys={keys} jumps={jumps} changes={setBlocks} leave={leaveDiff} source={`${pageReads}:${sides(comparison, overview, appliedReads)}`} />
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
  monaco.editor.defineTheme('wangcai', editorTheme(profile.theme));
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => { activeWorkspaceId = value?.workspaceId; });
  void context.global.publish('workspace:query', null);
  const response = await fetch(new URL('./ui.worker.js', import.meta.url));
  if (!response.ok) throw new Error('Cannot load Git diff worker');
  const workerURL = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  const workers = new Set<Worker>();
  const previous = self.MonacoEnvironment;
  const environment = { getWorker() {
    const worker = new Worker(workerURL, { type: 'module' });
    workers.add(worker);
    return worker;
  } };
  self.MonacoEnvironment = environment;
  return () => {
    offActive();
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerURL);
    if (self.MonacoEnvironment === environment) self.MonacoEnvironment = previous;
  };
}
