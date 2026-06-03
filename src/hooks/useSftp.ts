import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listSftpDirectory,
  makeRemoteDirectory,
  readRemoteFile,
  writeRemoteFile,
  writeRemoteFileBase64,
  type FolderUploadProgress,
  type RemoteFileReadResponse,
  type SftpFileEntry,
  type UploadResponse
} from '../lib/terminalApi';

interface UseSftpResult {
  files: SftpFileEntry[];
  currentPath: string;
  loading: boolean;
  error: string | null;
  navigate: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  goUp: () => Promise<void>;
  readFile: (path: string) => Promise<RemoteFileReadResponse>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string, parents?: boolean) => Promise<void>;
  uploadFile: (directory: string, file: File) => Promise<UploadResponse>;
  uploadFolder: (directory: string, files: FileList, onProgress: (progress: FolderUploadProgress) => void) => Promise<FolderUploadProgress>;
}

function joinRemotePath(directory: string, name: string): string {
  const cleanName = name.replace(/^[/\\]+/, '');
  if (!directory || directory === '/') return `/${cleanName}`;
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/, '')}${separator}${cleanName}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fileToBase64(file: File): Promise<string> {
  return arrayBufferToBase64(await file.arrayBuffer());
}

export function useSftp(slaveId: string, initialPath?: string): UseSftpResult {
  const [files, setFiles] = useState<SftpFileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentPathRef = useRef(initialPath || '/');

  const navigate = useCallback(async (path: string) => {
    try {
      setLoading(true);
      setError(null);
      const data = await listSftpDirectory(slaveId, path || '/');
      setFiles(data.files);
      setCurrentPath(data.cwd || path || '/');
      currentPathRef.current = data.cwd || path || '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [slaveId]);

  const refresh = useCallback(() => navigate(currentPathRef.current), [navigate]);

  const goUp = useCallback(() => {
    const parentPath = currentPathRef.current.split('/').slice(0, -1).join('/') || '/';
    return navigate(parentPath);
  }, [navigate]);

  const readFile = useCallback((path: string) => readRemoteFile(slaveId, path), [slaveId]);

  const writeFile = useCallback(async (path: string, content: string) => {
    await writeRemoteFile(slaveId, path, content);
  }, [slaveId]);

  const mkdir = useCallback(async (path: string, parents = false) => {
    await makeRemoteDirectory(slaveId, path, parents);
    if (!parents) await refresh();
  }, [refresh, slaveId]);

  const uploadFile = useCallback(async (directory: string, file: File) => {
    const targetPath = joinRemotePath(directory, file.name);
    const result = await writeRemoteFileBase64(slaveId, targetPath, await fileToBase64(file));
    await refresh();
    return result;
  }, [refresh, slaveId]);

  const uploadFolder = useCallback(async (
    directory: string,
    fileList: FileList,
    onProgress: (progress: FolderUploadProgress) => void
  ) => {
    const filesToUpload = Array.from(fileList);
    const progress: FolderUploadProgress = { total: filesToUpload.length, done: 0, current: '', errors: [] };
    const directorySet = new Set<string>();

    for (const file of filesToUpload) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = relativePath.split('/').filter(Boolean);
      for (let index = 1; index < parts.length; index += 1) {
        directorySet.add(joinRemotePath(directory, parts.slice(0, index).join('/')));
      }
    }

    for (const folderPath of Array.from(directorySet).sort((a, b) => a.length - b.length)) {
      try {
        await makeRemoteDirectory(slaveId, folderPath, true);
      } catch (error) {
        progress.errors.push({ relativePath: folderPath, message: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const file of filesToUpload) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = relativePath.split('/').filter(Boolean);
      const parent = parts.length > 1 ? joinRemotePath(directory, parts.slice(0, -1).join('/')) : directory;
      const targetPath = joinRemotePath(parent, file.name);
      progress.current = relativePath;
      onProgress({ ...progress });
      try {
        await writeRemoteFileBase64(slaveId, targetPath, await fileToBase64(file));
      } catch (error) {
        progress.errors.push({ relativePath, message: error instanceof Error ? error.message : String(error) });
      }
      progress.done += 1;
      onProgress({ ...progress });
    }

    await refresh();
    return progress;
  }, [refresh, slaveId]);

  useEffect(() => {
    if (slaveId) void navigate(initialPath || '/');
  }, [slaveId]);

  return {
    files,
    currentPath,
    loading,
    error,
    navigate,
    refresh,
    goUp,
    readFile,
    writeFile,
    mkdir,
    uploadFile,
    uploadFolder
  };
}
