import { act, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionPane } from './TerminalSessionPane';
import type { TerminalSessionPaneHandle, TerminalTab } from './TerminalSessionPane';

const terminalApiMock = vi.hoisted(() => ({
  buildTerminalWsUrl: vi.fn(),
  closeTerminalSession: vi.fn()
}));

const xtermMock = vi.hoisted(() => ({
  writes: [] as string[]
}));

vi.mock('../lib/terminalApi', () => terminalApiMock);

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn()
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
    write: vi.fn((value: string) => xtermMock.writes.push(value)),
    writeln: vi.fn()
  }))
}));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  static autoOutput = true;

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
      if (MockWebSocket.autoOutput) {
        this.onmessage?.({ data: JSON.stringify({ type: 'output', data: '$ ' }) } as MessageEvent<string>);
      }
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

const tab: TerminalTab = {
  id: 'terminal-session-1',
  sessionId: 'session-1',
  slaveId: 'vm1',
  name: 'VM1',
  host: '192.0.2.11',
  shell: '/bin/bash',
  status: 'connecting'
};

describe('TerminalSessionPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    xtermMock.writes = [];
    MockWebSocket.instances = [];
    MockWebSocket.autoOutput = true;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    terminalApiMock.buildTerminalWsUrl.mockReturnValue('ws://127.0.0.1/terminal/session-1');
    terminalApiMock.closeTerminalSession.mockResolvedValue(undefined);
  });

  it('forwards cwd messages to the parent pane state', async () => {
    const onCwdChange = vi.fn();

    render(
      <TerminalSessionPane
        active
        defaultRoot="/root"
        onCwdChange={onCwdChange}
        onStatusChange={vi.fn()}
        readOnly={false}
        system="Linux"
        tab={tab}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => {
      MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'cwd', data: '/root/debug' }) } as MessageEvent<string>);
    });

    expect(onCwdChange).toHaveBeenCalledWith('/root/debug');
  });

  it('sends Ctrl+C through the active terminal socket', async () => {
    const paneRef = createRef<TerminalSessionPaneHandle>();

    render(
      <TerminalSessionPane
        ref={paneRef}
        active
        defaultRoot="/root"
        onCwdChange={vi.fn()}
        onStatusChange={vi.fn()}
        readOnly={false}
        system="Linux"
        tab={tab}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => {
      paneRef.current?.stop();
    });

    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: 'input', data: '\u0003' }));
  });

  it('marks the pane disconnected when no first server message arrives', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOutput = false;
    const onStatusChange = vi.fn();

    const result = render(
      <TerminalSessionPane
        active
        defaultRoot="/root"
        onCwdChange={vi.fn()}
        onStatusChange={onStatusChange}
        readOnly={false}
        system="Linux"
        tab={tab}
      />
    );

    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(4000);
    });

    expect(onStatusChange).toHaveBeenCalledWith('disconnected');
    expect(xtermMock.writes.join('')).toContain('[连接超时]');
    result.unmount();
  });
});
