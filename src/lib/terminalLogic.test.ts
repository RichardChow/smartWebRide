import { describe, expect, it } from 'vitest';
import { slaveSessions } from '../data/mockRuntime';
import type { TerminalBufferState } from './terminalLogic';
import {
  buildRobotCommand,
  canOpenWritableTerminal,
  createMockPtyOutput,
  createRobotQuickCommand,
  createTerminalSession,
  reduceTerminalEvent
} from './terminalLogic';

describe('terminal lock and session logic', () => {
  it('allows writable terminal only for idle nodes or the lock holder', () => {
    expect(canOpenWritableTerminal(slaveSessions[0], 'Humphrey')).toBe(true);
    expect(canOpenWritableTerminal(slaveSessions[1], 'Humphrey')).toBe(false);
    expect(canOpenWritableTerminal(slaveSessions[2], 'Humphrey')).toBe(true);
    expect(canOpenWritableTerminal(slaveSessions[3], 'Humphrey')).toBe(false);
  });

  it('creates read-only terminal session for observers', () => {
    const session = createTerminalSession(slaveSessions[1], 'Humphrey', true);
    expect(session.readOnly).toBe(true);
    expect(session.shell).toBe('/bin/bash');
  });
});

describe('Robot quick command builder', () => {
  it('builds robot command with argumentfile, case and tag filters', () => {
    const quick = createRobotQuickCommand({
      root: '/opt/robot/Case',
      suiteOrFile: '/opt/robot/Case/Sanity_V8',
      caseName: 'update version',
      includeTags: 'sanity smoke',
      excludeTags: ['unstable'],
      argumentFile: 'local-debug.args'
    });

    expect(quick.commandPreview).toBe('robot -A local-debug.args -i sanity -i smoke -e unstable -t "update version" /opt/robot/Case/Sanity_V8');
    expect(buildRobotCommand(quick)).toBe(quick.commandPreview);
  });
});

describe('terminal event reducer and mock PTY output', () => {
  it('appends input, output and close events', () => {
    const initial: TerminalBufferState = { lines: [], status: 'open', lastHeartbeatAt: '' };
    const afterInput = reduceTerminalEvent(initial, { type: 'input', data: 'pwd', at: 'now' });
    const afterOutput = reduceTerminalEvent(afterInput, { type: 'output', data: '/opt/robot/Case', at: 'now' });
    const afterClose = reduceTerminalEvent(afterOutput, { type: 'close', code: 0, reason: 'client close', at: 'now' });

    expect(afterOutput.lines).toEqual(['$ pwd', '/opt/robot/Case']);
    expect(afterClose.status).toBe('closed');
  });

  it('returns Robot run output for robot commands and Ctrl+C output for stop', () => {
    expect(createMockPtyOutput('robot --version', slaveSessions[0]).join('\n')).toContain('Robot Framework');
    expect(createMockPtyOutput('robot -A local.args /opt/robot/Case', slaveSessions[0]).join('\n')).toContain('PASS');
    expect(createMockPtyOutput('\u0003', slaveSessions[0]).join('\n')).toContain('interrupted');
  });
});
