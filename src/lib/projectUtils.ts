import type { Project, RobotCase, RobotTreeNode, RunSession, VcsChange } from '../types';

export function flattenTree(node: RobotTreeNode): RobotTreeNode[] {
  return [node, ...node.children.flatMap((child) => flattenTree(child))];
}

export function findNodeByPath(project: Project, path: string): RobotTreeNode | undefined {
  return flattenTree(project.tree).find((node) => node.path === path);
}

export function listFiles(project: Project): RobotTreeNode[] {
  return flattenTree(project.tree).filter((node) => node.kind !== 'directory');
}

export function searchCases(project: Project, query: string, limit = 80): RobotCase[] {
  const value = query.trim().toLowerCase();
  const source = value
    ? project.cases.filter((item) => {
        const haystack = [item.name, item.filePath, item.suiteName, item.documentation, ...item.tags].join(' ').toLowerCase();
        return haystack.includes(value);
      })
    : project.cases;

  return source.slice(0, limit);
}

export function getDefaultRobotPath(project: Project): string {
  const caseFile = project.cases.find((item) => project.fileContents[item.filePath])?.filePath;
  if (caseFile) return caseFile;
  return project.robotFiles.find((path) => project.fileContents[path]) ?? project.robotFiles[0] ?? '';
}

export function getFileContent(project: Project, path: string): string {
  const content = project.fileContents[path];
  if (content) return content;
  const node = findNodeByPath(project, path);
  if (!node) return '请选择左侧文件。';
  return `${node.name}\n\n该文件已索引到项目树，但第一阶段 fixture 没有加载全文内容。\n后续接入后端后，可按需读取真实文件内容。`;
}

export function getOutlineCases(project: Project, path: string): RobotCase[] {
  return project.cases.filter((item) => item.filePath === path).slice(0, 80);
}

export function createMockRunSession(project: Project, target: string, nodeId: string): RunSession {
  const matchedCases = target ? searchCases(project, target, 12) : project.cases.slice(0, 12);
  const passed = Math.max(1, matchedCases.length - 1);
  const failed = matchedCases.length > 5 ? 1 : 0;
  const skipped = matchedCases.length > 8 ? 1 : 0;

  return {
    id: `run-${project.id}-${Date.now()}`,
    projectId: project.id,
    target: target || project.name,
    nodeId,
    status: failed > 0 ? 'failed' : 'passed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date(Date.now() + 61_000).toISOString(),
    passed,
    failed,
    skipped,
    logs: [
      `[smartWebRide] mock run created for ${project.name}`,
      `[selector] target=${target || 'suite'} node=${nodeId}`,
      `[robot] collected ${matchedCases.length || project.totalCases} candidate cases`,
      '[robot] --dryrun is skipped in phase 1',
      failed > 0 ? '[result] FAIL 1 case needs inspection' : '[result] PASS all selected cases'
    ]
  };
}

export function buildMockDiff(project: Project): VcsChange[] {
  const firstRobot = project.robotFiles[0] ?? '__init__.robot';
  const secondRobot = project.robotFiles[1] ?? firstRobot;
  const resource = project.resourceFiles[0] ?? 'resource/comm.resource';

  return [
    {
      id: `${project.id}:modified:${firstRobot}`,
      projectId: project.id,
      path: firstRobot,
      status: 'modified',
      diff: `--- ${firstRobot}\n+++ ${firstRobot}\n@@\n-    cli_check_cmd    run show status\n+    cli_check_cmd    run show status detail\n+    log    smartWebRide phase-1 mock diff`
    },
    {
      id: `${project.id}:modified:${secondRobot}`,
      projectId: project.id,
      path: secondRobot,
      status: 'modified',
      diff: `--- ${secondRobot}\n+++ ${secondRobot}\n@@\n-    [Tags]    sanity\n+    [Tags]    sanity    web-review`
    },
    {
      id: `${project.id}:added:${resource}`,
      projectId: project.id,
      path: resource,
      status: 'added',
      diff: `--- /dev/null\n+++ ${resource}\n@@\n+*** Keywords ***\n+smartwebride_placeholder\n+    No Operation`
    }
  ];
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
