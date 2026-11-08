// 共用的测试脚手架。放一个文件而不是各抄一份：同一件事的第二份实现比没有实现更坏。
// （Node 会把 test/ 下的 .mjs 当测试文件跑，这个文件没有用例，跑不出任何东西。）
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 浏览器层的"这台机器没装"与"装了但坏了"必须分开：后者会让整个浏览器层静默跳过，
// 整套测试照样全绿——那是假绿（审查抓到的严重项）。
export const playwrightBroken = await (async () => {
  try {
    await import('playwright');
    return false;
  } catch {
    return existsSync(join(here, '..', 'node_modules', 'playwright'));
  }
})();

// 自造一个临时仓库（cwd: repo），证据引用的是"本仓库某个文件的第 13 行"。
// 于是开发者一改那个文件，行号漂了，用例就变红——与产品逻辑无关（审查实测：
// 在 src/cost.mjs 顶部插一行，"hook：台账通过 → 0" 当场红）。改成自造临时仓库：
// 文件内容与行号都由测试自己定，不受发版状态与他人编辑影响。
export const repoWithEvidence = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-clean-'));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'ui.tsx'), '  scrollbar-gutter: stable;', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  await mkdir(join(dir, '.claimrail'), { recursive: true });
  await writeFile(
    join(dir, '.claimrail', 'decisions.json'),
    JSON.stringify({
      schema: 1,
      task_class: 'ui-new',
      forks: [
        {
          fork: '聊天滚动区：覆盖式滚动条还是留 gutter',
          options: ['覆盖式', '留 gutter'],
          picked: '留 gutter',
          evidence: { kind: 'repo', ref: 'src/ui.tsx:1', asserts: ['scrollbar-gutter'] },
          target: { file: 'src/ui.tsx', symbol: 'scrollbar-gutter' },
          cost_if_wrong: 'low',
          verified: true,
        },
      ],
    }),
    'utf8',
  );
  return dir;
};
