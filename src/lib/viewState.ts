import type { AppView } from '../types';

export const appViews: Array<{ id: AppView; label: string }> = [
  { id: 'slaves', label: 'Slave 状态' },
  { id: 'editor', label: 'RIDE Workspace' },
  { id: 'dashboard', label: '工作台' },
  { id: 'explorer', label: '项目浏览' },
  { id: 'run', label: '执行调试' },
  { id: 'reports', label: '报告' },
  { id: 'changes', label: '变更' }
];
