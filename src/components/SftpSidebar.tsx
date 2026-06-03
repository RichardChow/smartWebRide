import { ArrowUp, Edit2, File, FilePlus, FolderOpen, FolderPlus, FolderUp, RefreshCw, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useSftp } from '../hooks/useSftp';
import type { FolderUploadProgress, SftpFileEntry } from '../lib/terminalApi';

interface SftpSidebarProps {
  slaveId: string;
  connectionName: string;
  isOpen: boolean;
  terminalCwd?: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  readOnly?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SftpSidebar({
  slaveId,
  connectionName,
  isOpen,
  terminalCwd,
  onOpenFile,
  onClose,
  readOnly = false
}: SftpSidebarProps) {
  const { files, currentPath, loading, error, navigate, refresh, goUp, writeFile, mkdir, uploadFile, uploadFolder } = useSftp(slaveId, terminalCwd);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newItemType, setNewItemType] = useState<'file' | 'directory' | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [operationError, setOperationError] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [folderProgress, setFolderProgress] = useState<FolderUploadProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const lastTerminalCwdRef = useRef(terminalCwd);

  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => (a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name))),
    [files]
  );

  useEffect(() => {
    if (!isOpen || !terminalCwd || lastTerminalCwdRef.current === terminalCwd) return;
    lastTerminalCwdRef.current = terminalCwd;
    void navigate(terminalCwd);
  }, [isOpen, navigate, terminalCwd]);

  const joinPath = useCallback((name: string) => {
    const cleanName = name.trim().replace(/^[/\\]+/, '');
    if (!cleanName) return currentPath;
    if (currentPath === '/') return `/${cleanName}`;
    return `${currentPath.replace(/[\\/]+$/, '')}/${cleanName}`;
  }, [currentPath]);

  const busy = loading || uploadProgress !== null || folderProgress !== null;

  const handleEntryOpen = useCallback((entry: SftpFileEntry) => {
    setSelectedPath(entry.path);
    if (entry.type === 'directory') {
      void navigate(entry.path);
      return;
    }
    onOpenFile(entry.path);
  }, [navigate, onOpenFile]);

  const handleCreate = useCallback(async () => {
    const cleanName = newItemName.trim();
    if (!newItemType || !cleanName || readOnly) return;
    try {
      setOperationError('');
      const targetPath = joinPath(cleanName);
      if (newItemType === 'directory') await mkdir(targetPath);
      else {
        await writeFile(targetPath, '');
        await refresh();
      }
      setNewItemName('');
      setNewItemType(null);
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : String(err));
    }
  }, [joinPath, mkdir, newItemName, newItemType, readOnly, refresh, writeFile]);

  const handleUploadFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || readOnly) return;
    try {
      setOperationError('');
      setUploadProgress(10);
      await uploadFile(currentPath, file);
      setUploadProgress(100);
      window.setTimeout(() => setUploadProgress(null), 500);
    } catch (err) {
      setUploadProgress(null);
      setOperationError(err instanceof Error ? err.message : String(err));
    } finally {
      event.target.value = '';
    }
  }, [currentPath, readOnly, uploadFile]);

  const handleUploadFolder = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const uploadFiles = event.target.files;
    if (!uploadFiles || uploadFiles.length === 0 || readOnly) return;
    try {
      setOperationError('');
      setFolderProgress({ total: uploadFiles.length, done: 0, current: '', errors: [] });
      const result = await uploadFolder(currentPath, uploadFiles, setFolderProgress);
      if (result.errors.length > 0) setOperationError(`${result.errors.length} 个文件上传失败`);
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderProgress(null);
      event.target.value = '';
    }
  }, [currentPath, readOnly, uploadFolder]);

  if (!isOpen) return null;

  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <aside className="sftp-sidebar" aria-label="远程文件">
      <div className="sftp-header">
        <div className="sftp-title">
          <FolderOpen size={16} />
          <strong>{connectionName}</strong>
        </div>
        <div className="sftp-header-actions">
          <button className="icon-button" disabled={loading} onClick={() => void refresh()} title="刷新" aria-label="刷新文件">
            <RefreshCw size={15} className={loading ? 'spin-icon' : undefined} />
          </button>
          <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭文件侧栏">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="sftp-breadcrumb" aria-label="当前路径">
        <button onClick={() => void navigate('/')}>/</button>
        {pathParts.map((part, index) => {
          const fullPath = `/${pathParts.slice(0, index + 1).join('/')}`;
          return (
            <span key={fullPath}>
              <span>/</span>
              <button onClick={() => void navigate(fullPath)}>{part}</button>
            </span>
          );
        })}
      </div>

      <div className="sftp-toolbar">
        <button className="icon-button" disabled={currentPath === '/'} onClick={() => void goUp()} title="返回上一级" aria-label="返回上一级">
          <ArrowUp size={15} />
        </button>
        <button
          className="icon-button"
          disabled={readOnly || busy}
          onClick={() => { setNewItemType('directory'); setNewItemName(''); setOperationError(''); }}
          title="新建文件夹"
          aria-label="新建文件夹"
        >
          <FolderPlus size={15} />
        </button>
        <button
          className="icon-button"
          disabled={readOnly || busy}
          onClick={() => { setNewItemType('file'); setNewItemName(''); setOperationError(''); }}
          title="新建文件"
          aria-label="新建文件"
        >
          <FilePlus size={15} />
        </button>
        <button className="icon-button" disabled={readOnly || busy} onClick={() => fileInputRef.current?.click()} title="上传文件" aria-label="上传文件">
          <Upload size={15} />
        </button>
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleUploadFile} />
        <button className="icon-button" disabled={readOnly || busy} onClick={() => folderInputRef.current?.click()} title="上传文件夹" aria-label="上传文件夹">
          <FolderUp size={15} />
        </button>
        <input
          ref={folderInputRef}
          type="file"
          style={{ display: 'none' }}
          multiple
          // @ts-expect-error Chromium supports folder picking through this non-standard attribute.
          webkitdirectory=""
          onChange={handleUploadFolder}
        />
      </div>

      {newItemType ? (
        <form
          className="sftp-create-row"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          {newItemType === 'directory' ? <FolderPlus size={15} /> : <FilePlus size={15} />}
          <input
            autoFocus
            value={newItemName}
            onChange={(event) => setNewItemName(event.target.value)}
            placeholder={newItemType === 'directory' ? 'folder name' : 'file name'}
          />
          <button type="submit" disabled={!newItemName.trim() || busy}>OK</button>
          <button type="button" onClick={() => setNewItemType(null)}>Cancel</button>
        </form>
      ) : null}

      <div className="sftp-file-list">
        {error ? <div className="sftp-error">{error}</div> : null}
        {operationError ? <div className="sftp-error">{operationError}</div> : null}
        {uploadProgress !== null ? (
          <div className="sftp-progress">
            <span>上传文件 {uploadProgress}%</span>
            <div><i style={{ width: `${uploadProgress}%` }} /></div>
          </div>
        ) : null}
        {folderProgress !== null ? (
          <div className="sftp-progress">
            <span>上传文件夹 {folderProgress.done}/{folderProgress.total}{folderProgress.current ? ` ${folderProgress.current}` : ''}</span>
            <div><i style={{ width: `${folderProgress.total > 0 ? Math.round((folderProgress.done / folderProgress.total) * 100) : 0}%` }} /></div>
          </div>
        ) : null}
        {loading && files.length === 0 ? <div className="sftp-empty">加载中...</div> : null}
        {!loading && !error && sortedFiles.length === 0 ? <div className="sftp-empty">目录为空</div> : null}

        {!error
          ? sortedFiles.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={`sftp-row ${selectedPath === entry.path ? 'selected' : ''}`}
                onClick={() => handleEntryOpen(entry)}
                title={`${entry.permissions} ${entry.path}`}
                aria-label={`${entry.type === 'directory' ? '进入目录' : '打开文件'} ${entry.name}`}
              >
                {entry.type === 'directory' ? <FolderOpen size={16} /> : <File size={16} />}
                <span>{entry.name}</span>
                {entry.type === 'directory' ? <small>dir</small> : <small>{formatSize(entry.size)}</small>}
                {entry.type !== 'directory' ? <Edit2 size={13} className="sftp-row-action" /> : null}
              </button>
            ))
          : null}
      </div>
    </aside>
  );
}
