import type { RobotQuickCommand, SlaveSession, TerminalEvent, TerminalSession } from '../types';

export interface TerminalBufferState {
  lines: string[];
  status: TerminalSession['status'];
  lastHeartbeatAt: string;
}

export function canOpenWritableTerminal(session: SlaveSession | null, currentUser: string): boolean {
  if (!session || !session.capabilities.terminal) return false;
  if (session.mode === 'offline') return false;
  if (session.mode === 'idle') return true;
  return session.holder === currentUser && (session.mode === 'held' || session.mode === 'running');
}

export function isTerminalReadOnly(session: SlaveSession | null, currentUser: string): boolean {
  return !canOpenWritableTerminal(session, currentUser);
}

export function getDefaultShell(session: SlaveSession | null): string {
  if (!session) return '/bin/sh';
  return session.system.toLowerCase().includes('windows') ? 'powershell.exe' : '/bin/bash';
}

export function createTerminalSession(session: SlaveSession, currentUser: string, readOnly: boolean): TerminalSession {
  return {
    id: `term-${session.slaveId}-${Date.now()}`,
    slaveId: session.slaveId,
    shell: getDefaultShell(session),
    status: session.mode === 'offline' ? 'error' : 'open',
    createdAt: new Date().toISOString(),
    holder: readOnly ? session.holder || 'read-only' : currentUser,
    readOnly
  };
}

function quoteShellArg(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9_./:\\-]+$/.test(trimmed)) return trimmed;
  return `"${trimmed.replaceAll('"', '\\"')}"`;
}

function splitTags(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

export function createRobotQuickCommand(input: Omit<RobotQuickCommand, 'includeTags' | 'excludeTags' | 'commandPreview'> & {
  includeTags: string | string[];
  excludeTags: string | string[];
}): RobotQuickCommand {
  const command: RobotQuickCommand = {
    root: input.root,
    suiteOrFile: input.suiteOrFile,
    caseName: input.caseName,
    includeTags: splitTags(input.includeTags),
    excludeTags: splitTags(input.excludeTags),
    argumentFile: input.argumentFile,
    commandPreview: ''
  };
  command.commandPreview = buildRobotCommand(command);
  return command;
}

export function buildRobotCommand(command: RobotQuickCommand): string {
  const parts = ['robot'];
  if (command.argumentFile.trim()) parts.push('-A', quoteShellArg(command.argumentFile));
  for (const tag of command.includeTags) parts.push('-i', quoteShellArg(tag));
  for (const tag of command.excludeTags) parts.push('-e', quoteShellArg(tag));
  if (command.caseName.trim()) parts.push('-t', quoteShellArg(command.caseName));
  parts.push(quoteShellArg(command.suiteOrFile.trim() || command.root));
  return parts.filter(Boolean).join(' ');
}

export function reduceTerminalEvent(state: TerminalBufferState, event: TerminalEvent): TerminalBufferState {
  if (event.type === 'output') return { ...state, lines: [...state.lines, event.data] };
  if (event.type === 'input') return { ...state, lines: [...state.lines, `$ ${event.data}`] };
  if (event.type === 'resize') return { ...state, lines: [...state.lines, `# resize ${event.cols}x${event.rows}`] };
  if (event.type === 'heartbeat') return { ...state, lastHeartbeatAt: event.at };
  if (event.type === 'error') return { ...state, status: 'error', lines: [...state.lines, `ERROR: ${event.message}`] };
  return { ...state, status: 'closed', lines: [...state.lines, `# closed ${event.code}: ${event.reason}`] };
}

export function createInitialTerminalBuffer(session: TerminalSession, slave: SlaveSession): TerminalBufferState {
  const root = slave.allowedRoots[0] || '~';
  return {
    status: session.status,
    lastHeartbeatAt: new Date().toISOString(),
    lines: [
      `Connected to ${slave.name} (${slave.host})`,
      `Shell: ${session.shell}`,
      `Working directory: ${root}`,
      session.readOnly ? 'Read-only observer session. Command input is disabled.' : 'PTY session opened. Type commands or use Robot shortcuts.'
    ]
  };
}

export function createMockPtyOutput(command: string, slave: SlaveSession): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  if (trimmed === '\u0003') return ['^C', 'Current foreground command interrupted.'];
  if (trimmed === 'pwd') return [slave.allowedRoots[0] || '~'];
  if (trimmed === 'ls') return ['Sanity_V8  test_suite  resources  output'];
  if (trimmed === 'robot --version') return ['Robot Framework 7.x (mock Agent response)', `Python on ${slave.system}`];
  if (trimmed.includes('grep robot')) return [`${slave.holder || 'robot'}  2718  1  0  robot --listener smartWebRide`];
  if (trimmed.startsWith('robot ')) return [
    '==============================================================================',
    'smartWebRide mock PTY run',
    `Command: ${trimmed}`,
    'Output: output.xml',
    'Log: log.html',
    'Report: report.html',
    'PASS | 1 critical test, 1 passed, 0 failed'
  ];
  return [`mock shell: ${trimmed}`];
}
