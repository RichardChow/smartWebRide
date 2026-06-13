import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlaveSession } from '../types';
import { TerminalView } from './TerminalView';

const terminalApiMock = vi.hoisted(() => ({
  buildTerminalWsUrl: vi.fn(),
  closeTerminalSession: vi.fn(),
  createTerminalSession: vi.fn()
}));

const fitMock = vi.hoisted(() => ({
  fit: vi.fn()
}));

vi.mock('../lib/terminalApi', () => terminalApiMock);

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: fitMock.fit
  }))
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn()
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    cols: 80,
    rows: 24,
    options: {},
    dispose: vi.fn(),
    focus: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    open: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn()
  }))
}));

vi.mock('./SftpSidebar', () => ({
  SftpSidebar: ({
    onOpenFile,
    terminalCwd
  }: {
    onOpenFile: (path: string) => void;
    terminalCwd?: string;
  }) => (
    <aside data-testid="mock-sftp-sidebar" data-terminal-cwd={terminalCwd || ''}>
      <button type="button" data-testid="mock-open-file" onClick={() => onOpenFile('/tmp/swr-debug/arg.txt')}>
        open file
      </button>
    </aside>
  )
}));

vi.mock('./RemoteFileEditor', () => ({
  RemoteFileEditor: ({ filePath, onClose }: { filePath: string; onClose: () => void }) => (
    <section data-testid="terminal-file-editor" data-path={filePath}>
      editor
      <button type="button" data-testid="mock-close-editor" onClick={onClose}>
        close editor
      </button>
    </section>
  )
}));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    MockWebSocket.instances.push(this);
    window.setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: 'output', data: '$ ' }) } as MessageEvent<string>);
    }, 0);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send(data: string) {
    this.sent.push(data);
  }
}

class MockResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
}

function makeSlave(overrides: Partial<SlaveSession> = {}): SlaveSession {
  return {
    slaveId: 'vm1',
    name: 'VM1 sample debug node',
    host: '192.0.2.11',
    system: 'Linux / sample',
    connectionMode: 'remote-agent',
    agentVersion: 'swr-agent-test',
    pythonVersion: '3.12.3',
    robotVersion: 'Robot Framework 7.4.2',
    mode: 'held',
    holder: 'Humphrey',
    holderEmail: 'humphrey@example.com',
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    manualHoldReason: 'Web SSH debug lock',
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

async function renderWritableTerminal() {
  terminalApiMock.createTerminalSession.mockImplementation((
    _slaveId: string,
    options?: { mode?: 'reuse' | 'new' }
  ) => Promise.resolve({
    id: options?.mode === 'new' ? 'session-2' : 'session-1',
    slaveId: 'vm1',
    shell: '/bin/bash',
    status: 'open',
    createdAt: new Date().toISOString(),
    holder: 'Humphrey',
    readOnly: false
  }));
  terminalApiMock.buildTerminalWsUrl.mockImplementation((sessionId: string) => `ws://127.0.0.1/terminal/${sessionId}`);
  terminalApiMock.closeTerminalSession.mockResolvedValue(undefined);

  render(
    <TerminalView
      slaveSession={makeSlave()}
      currentUser="Humphrey"
      active
      onBack={vi.fn()}
      onReleaseSlave={vi.fn()}
      onSessionClosed={vi.fn()}
    />
  );

  await waitFor(() => expect(screen.getByTestId('sftp-toggle-button')).not.toBeDisabled());
}

describe('TerminalView split workbench', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('PointerEvent', MouseEvent);
  });

  it('keeps the terminal visible when a remote file is opened', async () => {
    await renderWritableTerminal();

    fireEvent.click(screen.getByTestId('mock-open-file'));

    expect(screen.getByTestId('terminal-file-editor')).toBeInTheDocument();
    expect(screen.getByTestId('web-ssh-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('web-ssh-terminal')).not.toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('smartssh-terminal-frame')).toHaveClass('split-active');
  });

  it('opens a new terminal split session from the plus tab button using the current cwd', async () => {
    await renderWritableTerminal();
    act(() => {
      MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'cwd', data: '/root/debug' }) } as MessageEvent<string>);
    });

    fireEvent.click(screen.getByLabelText('打开同屏分屏'));

    await waitFor(() => {
      expect(terminalApiMock.createTerminalSession).toHaveBeenCalledWith('vm1', {
        cwd: '/root/debug',
        mode: 'new'
      });
    });
    expect(screen.getByTestId('sftp-toggle-button')).not.toHaveClass('active');
    expect(screen.queryByTestId('mock-sftp-sidebar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-file-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('web-ssh-terminal')).toBeInTheDocument();
    expect(await screen.findByTestId('split-web-ssh-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('smartssh-terminal-frame')).toHaveClass('split-active');
    expect(MockWebSocket.instances).toHaveLength(2);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].readyState).toBe(MockWebSocket.OPEN);

    fireEvent.click(screen.getByLabelText('关闭左侧 terminal'));

    await waitFor(() => {
      expect(terminalApiMock.closeTerminalSession).toHaveBeenCalledWith('session-2');
    });
    expect(screen.queryByTestId('split-web-ssh-terminal')).not.toBeInTheDocument();
    expect(screen.getByTestId('web-ssh-terminal')).toBeInTheDocument();
  });

  it('opens a file over the split terminal without closing the split session', async () => {
    await renderWritableTerminal();

    fireEvent.click(screen.getByLabelText('打开同屏分屏'));
    expect(await screen.findByTestId('split-web-ssh-terminal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sftp-toggle-button'));
    fireEvent.click(screen.getByTestId('mock-open-file'));

    expect(screen.getByTestId('terminal-file-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('split-web-ssh-terminal')).not.toBeInTheDocument();
    expect(terminalApiMock.closeTerminalSession).not.toHaveBeenCalledWith('session-2');

    fireEvent.click(screen.getByTestId('mock-close-editor'));

    expect(await screen.findByTestId('split-web-ssh-terminal')).toBeInTheDocument();
    expect(terminalApiMock.closeTerminalSession).not.toHaveBeenCalledWith('session-2');
  });

  it('resets the split layout and reopens the file sidebar when releasing the slave', async () => {
    const onReleaseSlave = vi.fn();
    terminalApiMock.createTerminalSession.mockImplementation((
      _slaveId: string,
      options?: { mode?: 'reuse' | 'new' }
    ) => Promise.resolve({
      id: options?.mode === 'new' ? 'session-2' : 'session-1',
      slaveId: 'vm1',
      shell: '/bin/bash',
      status: 'open',
      createdAt: new Date().toISOString(),
      holder: 'Humphrey',
      readOnly: false
    }));
    terminalApiMock.buildTerminalWsUrl.mockImplementation((sessionId: string) => `ws://127.0.0.1/terminal/${sessionId}`);
    terminalApiMock.closeTerminalSession.mockResolvedValue(undefined);

    render(
      <TerminalView
        slaveSession={makeSlave()}
        currentUser="Humphrey"
        active
        onBack={vi.fn()}
        onReleaseSlave={onReleaseSlave}
        onSessionClosed={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByTestId('sftp-toggle-button')).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText('打开同屏分屏'));
    expect(await screen.findByTestId('split-web-ssh-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-sftp-sidebar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /释放 Slave/ }));

    expect(onReleaseSlave).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sftp-toggle-button')).toHaveClass('active');
    expect(screen.getByTestId('mock-sftp-sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('split-web-ssh-terminal')).not.toBeInTheDocument();
    expect(screen.getByTestId('smartssh-terminal-frame')).not.toHaveClass('split-active');
  });

  it('does not replay the previous split request after releasing and reconnecting', async () => {
    const onReleaseSlave = vi.fn();
    let mainSessionCount = 0;
    let splitSessionCount = 0;
    terminalApiMock.createTerminalSession.mockImplementation((
      _slaveId: string,
      options?: { mode?: 'reuse' | 'new' }
    ) => Promise.resolve({
      id: options?.mode === 'new' ? `session-split-${++splitSessionCount}` : `session-main-${++mainSessionCount}`,
      slaveId: 'vm1',
      shell: '/bin/bash',
      status: 'open',
      createdAt: new Date().toISOString(),
      holder: 'Humphrey',
      readOnly: false
    }));
    terminalApiMock.buildTerminalWsUrl.mockImplementation((sessionId: string) => `ws://127.0.0.1/terminal/${sessionId}`);
    terminalApiMock.closeTerminalSession.mockResolvedValue(undefined);

    const { rerender } = render(
      <TerminalView
        slaveSession={makeSlave()}
        currentUser="Humphrey"
        active
        releaseNonce={0}
        onBack={vi.fn()}
        onReleaseSlave={onReleaseSlave}
        onSessionClosed={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByTestId('sftp-toggle-button')).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText('打开同屏分屏'));
    expect(await screen.findByTestId('split-web-ssh-terminal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /释放 Slave/ }));

    rerender(
      <TerminalView
        slaveSession={makeSlave({ mode: 'idle', holder: '', holderEmail: '' })}
        currentUser="Humphrey"
        active={false}
        releaseNonce={1}
        onBack={vi.fn()}
        onReleaseSlave={onReleaseSlave}
        onSessionClosed={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(terminalApiMock.closeTerminalSession).toHaveBeenCalledWith('session-main-1');
    });

    rerender(
      <TerminalView
        slaveSession={makeSlave()}
        currentUser="Humphrey"
        active
        releaseNonce={1}
        onBack={vi.fn()}
        onReleaseSlave={onReleaseSlave}
        onSessionClosed={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByTestId('sftp-toggle-button')).not.toBeDisabled());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });

    const splitCalls = terminalApiMock.createTerminalSession.mock.calls.filter((call) => call[1]?.mode === 'new');
    expect(splitCalls).toHaveLength(1);
    expect(screen.getByTestId('sftp-toggle-button')).toHaveClass('active');
    expect(screen.getByTestId('mock-sftp-sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('split-web-ssh-terminal')).not.toBeInTheDocument();
    expect(screen.getByTestId('smartssh-terminal-frame')).not.toHaveClass('split-active');
  });

  it('updates the editor width through the split resizer', async () => {
    await renderWritableTerminal();
    fireEvent.click(screen.getByTestId('mock-open-file'));

    const workbench = screen.getByTestId('terminal-workbench-main');
    vi.spyOn(workbench, 'getBoundingClientRect').mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 1000,
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });

    const resizer = screen.getByRole('separator');
    fireEvent.pointerDown(resizer, { clientX: 460 });
    fireEvent.pointerMove(window, { clientX: 620 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(screen.getByTestId('smartssh-terminal-frame')).toHaveStyle('--editor-width: 62%');
    });
    expect(resizer).toHaveAttribute('aria-valuenow', '62');
  });
});
