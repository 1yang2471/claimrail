// init 写的台账模板。单独一个模块，是为了让 init 和 check 用同一份文本判"台账是不是
// 一字未动"——两处各写一份模板，改了一边另一边就静默失明（2026-11-08 的第一性复核）。
import { createHash } from 'node:crypto';

import { SCHEMA_VERSION } from './schema.mjs';

const TEMPLATE = {
  schema: SCHEMA_VERSION,
  task_class: 'ui-new',
  forks: [],
  no_fork_reason: '把本行改成"为什么这次没有分叉"，按任务改 task_class（合法值见 claimrail skill），或者填 forks',
};

// 字节级一致：init 写的就是这一串，check 比对的也是这一串。
export const TEMPLATE_TEXT = `${JSON.stringify(TEMPLATE, null, 2)}\n`;

export const templateHash = () => createHash('sha256').update(TEMPLATE_TEXT).digest('hex');

// 即使模型把文件重新序列化（缩进/换行变了），占位理由还在，就仍是"没申报"。
// 哈希抓字节，这一句抓语义上的模板。0.2.5 及更早的旧占位行也算：文案这轮扩了
// task_class 提示，不认旧串的话，老仓库里被重新序列化过的模板会静默漏拦。
const PLACEHOLDER_REASONS = new Set([
  TEMPLATE.no_fork_reason,
  '把本行改成"为什么这次没有分叉"，或者填 forks',
]);
export const isTemplateReason = (reason) => PLACEHOLDER_REASONS.has(reason);
