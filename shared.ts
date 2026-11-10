import type { Profile, WorkspaceActive } from '@lengmoxxl/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight?: number };
export type Settings = Profile & { font: Font; autoRefresh: boolean };

export interface GitFile { path: string; oldPath?: string; status: string }
export type Stage = 'staged' | 'unstaged' | 'untracked' | 'conflicted';
export interface Change extends GitFile {
  stage: Stage;
  /** The blob each side of this change is read from, as `git status` names them: only the sides a diff of the change
   *  reads, since its worktree side is the file the page watches. */
  headBlob?: string;
  indexBlob?: string;
}
export interface Commit { sha: string; author: string; time: number; subject: string; refs: string[] }
export interface History { commits: Commit[]; hasMore: boolean }
export interface Overview extends History {
  root: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  head: string;
  changes: Change[];
  truncated: boolean;
}
export type Comparison = GitFile & ({ source: Stage } | { source: 'commit'; rev: string })
export interface Diff { oldText: string; newText: string; notice?: string }
export interface OverviewRequest { terminal: WorkspaceActive }
export interface HistoryRequest { terminal: WorkspaceActive; root: string; head: string; skip: number }
export interface FilesRequest { terminal: WorkspaceActive; root: string; rev: string }
export interface DiffRequest { terminal: WorkspaceActive; root: string; comparison: Comparison }
/** An empty path list gives up what that tab watched before. */
export interface WatchRequest {
  holder: string;
  machine: WorkspaceActive['machine'];
  paths: string[];
}
