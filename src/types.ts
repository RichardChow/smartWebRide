export type FileKind = 'directory' | 'robot' | 'resource' | 'config' | 'script' | 'data' | 'text' | 'case' | 'keyword' | 'other';

export interface RobotTreeNode {
  id: string;
  name: string;
  path: string;
  kind: FileKind;
  extension: string;
  size: number;
  children: RobotTreeNode[];
}

export interface RobotCase {
  id: string;
  projectId: string;
  name: string;
  filePath: string;
  suiteName: string;
  tags: string[];
  documentation: string;
  steps: string[];
  line: number;
}

export interface FileOutline {
  sections: Array<{ name: string; line: number }>;
  resources: string[];
  libraries: string[];
  forceTags: string[];
}

export interface Project {
  id: string;
  name: string;
  root: string;
  description: string;
  recentOpened: string;
  tree: RobotTreeNode;
  fileStats: Record<string, number>;
  totalSize: number;
  totalFiles: number;
  totalRobotFiles: number;
  totalResourceFiles: number;
  totalCases: number;
  robotFiles: string[];
  resourceFiles: string[];
  cases: RobotCase[];
  fileOutlines: Record<string, FileOutline>;
  fileContents: Record<string, string>;
}

export interface ExecutionNode {
  id: string;
  name: string;
  host: string;
  system: string;
  status: 'idle' | 'locked' | 'running' | 'offline';
  owner: string;
  lockUntil: string;
  lastRun: string;
}

export interface RunSession {
  id: string;
  projectId: string;
  target: string;
  nodeId: string;
  status: 'queued' | 'running' | 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  logs: string[];
  passed: number;
  failed: number;
  skipped: number;
}

export interface ReportSummary {
  id: string;
  projectId: string;
  runName: string;
  status: 'passed' | 'failed';
  duration: string;
  passed: number;
  failed: number;
  skipped: number;
  failedCases: RobotCase[];
}

export interface VcsChange {
  id: string;
  projectId: string;
  path: string;
  status: 'modified' | 'added' | 'deleted';
  diff: string;
}

export interface SlaveSession {
  slaveId: string;
  name: string;
  host: string;
  system: string;
  connectionMode: 'remote-agent' | 'local-agent';
  agentVersion: string;
  mode: 'idle' | 'held' | 'running' | 'offline';
  holder: string;
  heartbeatAt: string;
  expiresAt: string;
  manualHoldReason: string;
  activeRunId: string;
  processSignal: 'none' | 'robot' | 'python' | 'unknown';
  jenkinsJob?: string;
  allowedRoots: string[];
  capabilities: {
    browseRobotRoot: boolean;
    runRobot: boolean;
    svnOps: boolean;
    processInspect: boolean;
    terminal: boolean;
    killProcess: boolean;
  };
}

export interface TerminalSession {
  id: string;
  slaveId: string;
  shell: string;
  status: 'connecting' | 'open' | 'closed' | 'error';
  createdAt: string;
  holder: string;
  readOnly: boolean;
}

export type TerminalEvent =
  | { type: 'output'; data: string; at: string }
  | { type: 'input'; data: string; at: string }
  | { type: 'resize'; cols: number; rows: number; at: string }
  | { type: 'close'; code: number; reason: string; at: string }
  | { type: 'error'; message: string; at: string }
  | { type: 'heartbeat'; at: string };

export interface RobotQuickCommand {
  root: string;
  suiteOrFile: string;
  caseName: string;
  includeTags: string[];
  excludeTags: string[];
  argumentFile: string;
  commandPreview: string;
}

export interface SelectionState {
  checkedNodeIds: string[];
  partiallyCheckedNodeIds: string[];
  includedTags: string[];
  excludedTags: string[];
  argumentFile: string;
}

export interface KeywordUsage {
  filePath: string;
  caseName: string;
  line: number;
}

export interface KeywordIndex {
  name: string;
  type: 'builtin' | 'library' | 'resource' | 'user' | 'control' | 'variable' | 'unresolved';
  sourceFile: string;
  line: number;
  arguments: string[];
  documentation: string;
  usages: KeywordUsage[];
}

export interface RunPlan {
  projectId: string;
  slaveId: string;
  selectedSuites: string[];
  selectedCases: RobotCase[];
  includeTags: string[];
  excludeTags: string[];
  argumentFile: string;
  commandPreview: string;
  readOnly: boolean;
}

export interface DebugState {
  status: 'idle' | 'running' | 'paused' | 'stopping' | 'stopped';
  currentStep: number;
  availableControls: Array<'run' | 'pause' | 'continue' | 'next' | 'stepOver' | 'stop'>;
}

export interface FlowNode {
  id: string;
  label: string;
  type: 'step' | 'if' | 'for' | 'while' | 'try' | 'end';
  sourceLine: number;
  status: 'idle' | 'active' | 'passed' | 'failed';
}

export type AppView = 'slaves' | 'terminal' | 'dashboard' | 'explorer' | 'editor' | 'run' | 'reports' | 'changes';
