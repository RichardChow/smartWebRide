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
  SftpSidebar: ({ onOpenFile, terminalCwd }: { onOpenFile: (path: string) => void; terminalCwd?: string }) => (
    <aside data-testid="mock-sftp-sidebar" data-terminal-cwd={terminalCwd || ''}>
      <button type="button" data-testid="mock-open-file" onClick={() => onOpenFile('/tmp/swr-debug/arg.txt')}>
        open file
      </button>
    </aside>
  )
}));

vi.mock('./RemoteFileEditor', () => ({
  RemoteFileEditor: ({ filePath }: { filePath: string }) => (
    <section data-testid="terminal-file-editor" data-path={filePath}>
      editor
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
    mode: 'held',
    holder: 'Humphrey',
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
  terminalApiMock.createTerminalSession.mockResolvedValue({
    id: 'session-1',
    slaveId: 'vm1',
    shell: '/bin/bash',
    status: 'open',
    createdAt: new Date().toISOString(),
    holder: 'Humphrey',
    readOnly: false
  });
  terminalApiMock.buildTerminalWsUrl.mockReturnValue('ws://127.0.0.1/terminal/session-1');
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

  it('opens the current directory split surface from the plus tab button', async () => {
    await renderWritableTerminal();
    act(() => {
      MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'cwd', data: '/root/debug' }) } as MessageEvent<string>);
    });

    fireEvent.click(screen.getByLabelText('打开同屏分屏'));

    expect(screen.getByTestId('mock-sftp-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('mock-sftp-sidebar')).toHaveAttribute('data-terminal-cwd', '/root/debug');
    expect(screen.getByTestId('terminal-split-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-file-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('web-ssh-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('smartssh-terminal-frame')).toHaveClass('split-active');

    fireEvent.click(screen.getByTestId('mock-open-file'));

    expect(screen.queryByTestId('terminal-split-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-file-editor')).toHaveAttribute('data-path', '/tmp/swr-debug/arg.txt');
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
