import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'public', 'fixtures', 'generated-fixtures.json');
const textExtensions = new Set(['.robot', '.resource', '.txt', '.yaml', '.yml', '.py', '.bat']);
const ignoredExtensions = new Set(['.pyc']);
const maxContentBytes = 80_000;
const maxSampleFiles = 36;

const projectConfigs = [
  {
    id: 'sanity-v8',
    name: 'Sanity_V8',
    root: 'test_data/Case/Sanity_V8',
    description: '日常 sanity 调试入口，目录规模适合默认展示。',
    caseStepLimit: 8
  },
  {
    id: 'test-suite',
    name: 'test_suite',
    root: 'test_data/Case/test_suite',
    description: '大规模真实用例集合，用于验证树、搜索和筛选性能。',
    caseStepLimit: 0
  }
];

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function classifyFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.robot') return 'robot';
  if (extension === '.resource') return 'resource';
  if (['.yaml', '.yml'].includes(extension)) return 'config';
  if (['.py', '.bat', '.sh'].includes(extension)) return 'script';
  if (['.xlsx', '.xlsm', '.pcap', '.hltlog'].includes(extension)) return 'data';
  if (['.txt', '.md', '.log'].includes(extension)) return 'text';
  return 'other';
}

function shouldIgnore(name, extension) {
  return ignoredExtensions.has(extension) || name.startsWith('~$') || name === '__pycache__';
}

async function scanDirectory(rootAbs, currentAbs, projectId, relative = '') {
  const entries = await readdir(currentAbs, { withFileTypes: true });
  const children = [];

  for (const entry of entries) {
    const entryAbs = path.join(currentAbs, entry.name);
    const entryRelative = normalizePath(path.join(relative, entry.name));
    const extension = entry.isFile() ? path.extname(entry.name).toLowerCase() : '';

    if (shouldIgnore(entry.name, extension)) continue;

    if (entry.isDirectory()) {
      const child = await scanDirectory(rootAbs, entryAbs, projectId, entryRelative);
      children.push(child);
      continue;
    }

    if (!entry.isFile()) continue;

    const stats = statSync(entryAbs);
    children.push({
      id: `${projectId}:${entryRelative}`,
      name: entry.name,
      path: entryRelative,
      kind: classifyFile(entry.name),
      extension: extension || 'none',
      size: stats.size,
      children: []
    });
  }

  children.sort((a, b) => {
    const aDir = a.children.length > 0;
    const bDir = b.children.length > 0;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });

  return {
    id: `${projectId}:${relative || '.'}`,
    name: relative ? path.basename(relative) : path.basename(rootAbs),
    path: relative,
    kind: 'directory',
    extension: '',
    size: 0,
    children
  };
}

function flattenTree(node, output = []) {
  output.push(node);
  for (const child of node.children) flattenTree(child, output);
  return output;
}

function readTextSample(filePath) {
  const stats = statSync(filePath);
  if (stats.size > maxContentBytes) return '';
  return readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function parseRobotFile(projectId, relativePath, content, caseStepLimit) {
  const lines = content.split('\n');
  const cases = [];
  const sections = [];
  const resources = [];
  const libraries = [];
  const forceTags = [];
  let section = '';
  let currentCase = null;

  function commitCase() {
    if (!currentCase) return;
    currentCase.steps = currentCase.steps.slice(0, caseStepLimit);
    currentCase.tags = Array.from(new Set([...forceTags, ...currentCase.tags]));
    cases.push(currentCase);
    currentCase = null;
  }

  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/g, '');
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\*{3}\s*(.*?)\s*\*{3}$/);

    if (sectionMatch) {
      commitCase();
      section = sectionMatch[1].toLowerCase();
      sections.push({ name: sectionMatch[1], line: index + 1 });
      return;
    }

    if (!trimmed || trimmed.startsWith('#')) return;

    if (section.includes('setting')) {
      const parts = trimmed.split(/\s{2,}|\t+/).filter(Boolean);
      const key = parts[0]?.toLowerCase();
      if (key === 'resource' && parts[1]) resources.push(parts[1]);
      if (key === 'library' && parts[1]) libraries.push(parts.slice(1).join(' '));
      if (key === 'force tags') forceTags.push(...parts.slice(1));
      return;
    }

    if (!section.includes('test case')) return;

    const isIndented = /^\s/.test(line);
    if (!isIndented) {
      commitCase();
      currentCase = {
        id: `${projectId}:${relativePath}:${index + 1}`,
        projectId,
        name: trimmed,
        filePath: relativePath,
        suiteName: path.basename(relativePath, path.extname(relativePath)),
        tags: [],
        documentation: '',
        steps: [],
        line: index + 1
      };
      return;
    }

    if (!currentCase) return;

    if (trimmed.toLowerCase().startsWith('[tags]')) {
      currentCase.tags.push(...trimmed.replace(/^\[Tags\]\s*/i, '').split(/\s{2,}|\t+/).filter(Boolean));
      return;
    }

    if (trimmed.toLowerCase().startsWith('[documentation]')) {
      currentCase.documentation = trimmed.replace(/^\[Documentation\]\s*/i, '').slice(0, 220);
      return;
    }

    if (caseStepLimit > 0 && !trimmed.startsWith('...')) currentCase.steps.push(trimmed.slice(0, 180));
  });

  commitCase();

  return {
    cases,
    outline: {
      sections,
      resources: Array.from(new Set(resources)),
      libraries: Array.from(new Set(libraries)),
      forceTags: Array.from(new Set(forceTags))
    }
  };
}

function collectStats(nodes) {
  const stats = {};
  let totalSize = 0;
  let totalFiles = 0;

  for (const node of nodes) {
    if (node.kind === 'directory') continue;
    const key = node.extension || 'none';
    stats[key] = (stats[key] || 0) + 1;
    totalSize += node.size;
    totalFiles += 1;
  }

  return { stats, totalSize, totalFiles };
}

async function buildProject(config) {
  const rootAbs = path.join(repoRoot, config.root);
  if (!existsSync(rootAbs)) throw new Error(`Missing demo project directory: ${config.root}`);

  const tree = await scanDirectory(rootAbs, rootAbs, config.id);
  const nodes = flattenTree(tree);
  const files = nodes.filter((node) => node.kind !== 'directory');
  const robotFiles = files.filter((node) => node.kind === 'robot');
  const resourceFiles = files.filter((node) => node.kind === 'resource');
  const { stats, totalSize, totalFiles } = collectStats(nodes);
  const cases = [];
  const fileOutlines = {};
  const fileContents = {};

  for (const file of files) {
    const extension = file.extension.toLowerCase();
    const absolute = path.join(rootAbs, file.path);

    if ((file.kind === 'robot' || file.kind === 'resource') && statSync(absolute).size <= maxContentBytes) {
      const content = readTextSample(absolute);
      const parsed = parseRobotFile(config.id, file.path, content, config.caseStepLimit);
      cases.push(...parsed.cases);
      fileOutlines[file.path] = parsed.outline;
    }

    const shouldSample =
      Object.keys(fileContents).length < maxSampleFiles &&
      textExtensions.has(extension) &&
      statSync(absolute).size <= maxContentBytes &&
      (file.kind === 'robot' || file.kind === 'resource' || file.path.includes('config') || file.path.includes('resource'));

    if (shouldSample) fileContents[file.path] = readTextSample(absolute);
  }

  return {
    id: config.id,
    name: config.name,
    root: config.root,
    description: config.description,
    recentOpened: new Date().toISOString(),
    tree,
    fileStats: stats,
    totalSize,
    totalFiles,
    totalRobotFiles: robotFiles.length,
    totalResourceFiles: resourceFiles.length,
    totalCases: cases.length,
    robotFiles: robotFiles.map((file) => file.path),
    resourceFiles: resourceFiles.map((file) => file.path),
    cases,
    fileOutlines,
    fileContents
  };
}

const projects = [];
for (const config of projectConfigs) {
  projects.push(await buildProject(config));
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), projects }, null, 2)}\n`, 'utf8');

console.log(`Generated ${outputPath}`);
for (const project of projects) {
  console.log(`${project.name}: ${project.totalFiles} files, ${project.totalRobotFiles} robot files, ${project.totalCases} cases`);
}
