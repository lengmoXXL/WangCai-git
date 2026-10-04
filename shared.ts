import type { Profile, WorkspaceActive } from '@wangcai/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight?: number };
export type Settings = Profile & { font: Font };

export interface GitFile { path: string; oldPath?: string; status: string }
export type Stage = 'staged' | 'unstaged' | 'untracked' | 'conflicted';
export interface Change extends GitFile { stage: Stage }
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
export interface Comparison extends GitFile { source: Stage | 'commit'; rev?: string }
export interface Diff { oldText: string; newText: string; notice?: string }
export interface GitRequest {
  terminal: WorkspaceActive;
  root?: string;
  head?: string;
  skip?: number;
  rev?: string;
  comparison?: Comparison;
}
