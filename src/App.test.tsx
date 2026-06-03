import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlaveSession } from './types';

const apiMocks = vi.hoisted(() => ({
  forceTakeover: vi.fn(),
  listSlaves: vi.fn(),
  lockSlave: vi.fn(),
  releaseSlave: vi.fn()
}));

vi.mock('./lib/terminalApi', () => apiMocks);

vi.mock('./components/SlaveStatusHome', () => ({
  SlaveStatusHome: ({ onForceTakeover }: { onForceTakeover: (slaveId: string, reason: string) => void }) => (
    <button onClick={() => onForceTakeover('vm1', '紧急调试')}>强制接管</button>
  )
}));

vi.mock('./components/TerminalView', () => ({
  TerminalView: ({ forceReadOnly, slaveSession }: { forceReadOnly?: boolean; slaveSession: { holder: string } | null }) => (
    <div data-testid="terminal-view" data-holder={slaveSession?.holder || ''} data-readonly={String(Boolean(forceReadOnly))}>
      {forceReadOnly ? '只读观察' : '可写调试'}
    </div>
  )
}));

import { App } from './App';

function makeSlave(overrides: Partial<SlaveSession> = {}): SlaveSession {
  return {
    slaveId: 'vm1',
    name: 'VM1 main debug node',
    host: '192.0.2.11',
    system: 'Linux / VMware',
    connectionMode: 'remote-agent',
    agentVersion: 'swr-agent-test',
    mode: 'held',
    holder: 'humphrey1',
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    manualHoldReason: 'Web SSH 调试锁',
    activeRunId: '',
    processSignal: 'none',
    allowedRoots: ['/tmp/swr-debug', '/opt/robot/cases'],
    capabilities: {
      browseRobotRoot: true,
      runRobot: true,
      svnOps: false,
      processInspect: true,
      terminal: true,
      killProcess: true
    },
    ...overrides
  };
}

describe('App takeover flow', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('enters writable terminal from the takeover response instead of stale slave state', async () => {
    const heldByOther = makeSlave();
    const takenByCurrentUser = makeSlave({
      holder: 'Humphrey',
      manualHoldReason: '紧急调试'
    });
    apiMocks.listSlaves.mockResolvedValue([heldByOther]);
    apiMocks.forceTakeover.mockResolvedValue(takenByCurrentUser);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '强制接管' }));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-readonly', 'false');
    });
    expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-holder', 'Humphrey');
    expect(apiMocks.forceTakeover).toHaveBeenCalledWith('vm1', 'Humphrey', '紧急调试');
  });
});
