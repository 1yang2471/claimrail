// 申报无分叉时的审计线索。
//
// 「没被申报的分叉」是这套机制唯一看不见的洞（README 与 PRD 都这么写）。这一层不假装
// 能看见分叉——程序判不了"这里有没有过岔路口"。它只记一件机械可查的事：台账说本次
// 没有分叉，而 diff 确实落在这一类任务的面上。
//
// 刻意不参与判定：check 的退出码、门规则、钩子都不读它。它只出现在屏幕上与 --json 里，
// 供人抽查与 bench 统计。给它拦截权就等于把"文件类型"当成"有没有分叉"的证据——
// 那不是这套机制想说的话。
//
// refactor 没有列入：它的"面"就是任意代码，命中率接近 100%，信号没有区分度。
// typo / rename / bugfix-known-cause 本来就是免走协议的类别，同样没有面。
const SURFACES = {
  'ui-new': /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less)$/i,
  'docs-new': /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst)$/i,
  // 接口类只认"看起来就是接口定义"的文件：路径里有 api/routes/controllers，
  // 或文件名是 openapi/swagger，或 .proto/.graphql。普通的 config/*.yaml 不算——
  // 否则任何一个改配置的任务都会被记一笔。
  'api-design': /(^|\/)(api|routes?|controllers?)\/|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.(proto|graphql|gql)$/i,
};

export const AUDIT_CLASSES = Object.keys(SURFACES);

// files 来自 changedLines：已改行的文件、未跟踪的新文件、rename/copy 的落地路径。
// 去重后再过滤，顺序保持调用方给的顺序（人读起来像 diff 的顺序）。
export function surfaceFiles(taskClass, files = []) {
  const re = SURFACES[taskClass];
  if (!re) return [];
  return [...new Set(files.map(String))].filter((f) => re.test(f));
}
