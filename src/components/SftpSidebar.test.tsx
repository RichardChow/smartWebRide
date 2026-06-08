import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpSidebar } from './SftpSidebar';
import type { SftpFileEntry } from '../lib/terminalApi';

const sftpMock = vi.hoisted(() => ({
  useSftp: vi.fn()
}));

vi.mock('../hooks/useSftp', () => ({
  useSftp: sftpMock.useSftp
}));

const navigate = vi.fn();
const refresh = vi.fn();
const goUp = vi.fn();
const writeFile = vi.fn();
const mkdir = vi.fn();
const uploadFile = vi.fn();
const uploadFolder = vi.fn();

function entry(overrides: Partial<SftpFileEntry>): SftpFileEntry {
  return {
    name: 'item',
    type: 'file',
    size: 12,
    permissions: '-rw-r--r--',
    owner: 'root',
    group: 'root',
    modified: 0,
    path: '/root/item',
    ...overrides
  };
}

function mockUseSftp(currentPath = '/root') {
  sftpMock.useSftp.mockReturnValue({
    files: [
      entry({ name: 'logs', type: 'directory', permissions: 'drwxr-xr-x', path: '/root/logs' }),
      entry({ name: 'arg.txt', path: '/root/arg.txt' })
    ],
    currentPath,
    loading: false,
    error: null,
    navigate,
    refresh,
    goUp,
    writeFile,
    mkdir,
    uploadFile,
    uploadFolder
  });
}

function renderSidebar(props: Partial<Parameters<typeof SftpSidebar>[0]> = {}) {
  const onOpenFile = vi.fn();
  const view = render(
    <SftpSidebar
      slaveId="vm1"
      connectionName="VM1"
      isOpen
      terminalCwd="/root"
      onOpenFile={onOpenFile}
      onClose={vi.fn()}
      {...props}
    />
  );
  return { ...view, onOpenFile };
}

describe('SftpSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSftp();
  });

  it('opens a directory without syncing back to an unchanged terminal cwd', () => {
    const view = renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: '进入目录 logs' }));

    expect(navigate).toHaveBeenCalledWith('/root/logs');
    navigate.mockClear();
    mockUseSftp('/root/logs');
    view.rerender(
      <SftpSidebar
        slaveId="vm1"
        connectionName="VM1"
        isOpen
        terminalCwd="/root"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(navigate).not.toHaveBeenCalledWith('/root');
  });

  it('opens a file from one click', () => {
    const { onOpenFile } = renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: '打开文件 arg.txt' }));

    expect(onOpenFile).toHaveBeenCalledWith('/root/arg.txt');
  });

  it('syncs to the terminal cwd when the terminal cwd changes', () => {
    const view = renderSidebar();

    view.rerender(
      <SftpSidebar
        slaveId="vm1"
        connectionName="VM1"
        isOpen
        terminalCwd="/home/demo"
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(navigate).toHaveBeenCalledWith('/home/demo');
  });

  it('uses the stable sidebar class', () => {
    renderSidebar();

    expect(screen.getByLabelText('远程文件')).toHaveClass('sftp-sidebar');
  });
});
