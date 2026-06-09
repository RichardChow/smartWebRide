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
  SlaveStatusHome: ({
    onEnterSlave,
    onForceTakeover,
    onReleaseSlave
  }: {
    onEnterSlave: (slaveId: string, readOnly: boolean) => void;
    onForceTakeover: (slaveId: string, reason: string) => void;
    onReleaseSlave: (slaveId: string) => void;
  }) => (
    <div>
      <button onClick={() => onEnterSlave('vm1', false)}>进入终端</button>
      <button onClick={() => onReleaseSlave('vm1')}>释放 Slave</button>
      <button onClick={() => onForceTakeover('vm1', '紧急调试')}>强制接管</button>
    </div>
  )
}));

vi.mock('./components/HomeHeroPreview', async () => {
  const slaveModule = await vi.importMock<typeof import('./components/SlaveStatusHome')>('./components/SlaveStatusHome');
  return {
    HomeHeroPreview: (props: {
      onEnterSlave: (slaveId: string, readOnly: boolean) => void;
      onForceTakeover: (slaveId: string, reason: string) => void;
      onReleaseSlave: (slaveId: string) => void;
    }) => (
      <div>
        <h1>Hero Preview Route</h1>
        <slaveModule.SlaveStatusHome {...props} />
      </div>
    )
  };
});

vi.mock('./components/TerminalView', () => ({
  TerminalView: ({
    forceReadOnly,
    onReleaseSlave,
    slaveSession
  }: {
    forceReadOnly?: boolean;
    onReleaseSlave: () => void;
    slaveSession: { holder: string } | null;
  }) => (
    <div data-testid="terminal-view" data-holder={slaveSession?.holder || ''} data-readonly={String(Boolean(forceReadOnly))}>
      {forceReadOnly ? '只读观察' : '可写调试'}
      <button onClick={onReleaseSlave}>终端释放</button>
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
    pythonVersion: '3.12.3',
    robotVersion: 'Robot Framework 7.4.2',
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
    window.history.pushState(null, '', '/');
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

  it('returns to the slave list when releasing from terminal', async () => {
    const heldByCurrentUser = makeSlave({ holder: 'Humphrey' });
    const released = makeSlave({ mode: 'idle', holder: '', expiresAt: '', manualHoldReason: '' });
    apiMocks.listSlaves.mockResolvedValue([heldByCurrentUser]);
    apiMocks.releaseSlave.mockResolvedValue(released);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '进入终端' }));
    await screen.findByTestId('terminal-view');
    fireEvent.click(screen.getByRole('button', { name: '终端释放' }));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-view').parentElement).toHaveStyle({ display: 'none' });
    });
    expect(apiMocks.releaseSlave).toHaveBeenCalledWith('vm1', 'Humphrey');
  });

  it('keeps the default home route separate from the hero preview route', async () => {
    apiMocks.listSlaves.mockResolvedValue([makeSlave({ mode: 'idle', holder: '' })]);

    render(<App />);

    await screen.findByRole('button', { name: '进入终端' });
    expect(screen.queryByText('Hero Preview Route')).not.toBeInTheDocument();
  });

  it('renders the hero preview route without changing slave actions', async () => {
    const idleSlave = makeSlave({ mode: 'idle', holder: '' });
    apiMocks.listSlaves.mockResolvedValue([idleSlave]);
    apiMocks.lockSlave.mockResolvedValue(makeSlave({ holder: 'Humphrey' }));
    window.history.pushState(null, '', '/preview/home-hero');

    render(<App />);

    expect(await screen.findByText('Hero Preview Route')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '进入终端' }));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-readonly', 'false');
    });
  });
});
