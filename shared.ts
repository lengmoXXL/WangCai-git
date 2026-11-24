import type { Profile, WorkspaceActive } from '@lengmoxxl/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string };
export type Settings = Profile & { font: Font; autoRefresh: boolean };

export interface GitFile { path: string; oldPath?: string; status: string }
export type Stage = 'staged' | 'unstaged' | 'untracked' | 'conflicted';
export interface Change extends GitFile {
  stage: Stage;
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
export interface OverviewRequest { terminal: WorkspaceActive }
export interface HistoryRequest { terminal: WorkspaceActive; root: string; head: string; skip: number }
export interface FilesRequest { terminal: WorkspaceActive; root: string; rev: string }
