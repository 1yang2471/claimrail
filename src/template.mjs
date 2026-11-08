// init 写的台账模板。单独一个模块，是为了让 init 和 check 用同一份文本判"台账是不是
// 一字未动"——两处各写一份模板，改了一边另一边就静默失明（2026-11-08 的第一性复核）。
import { createHash } from 'node:crypto';

import { SCHEMA_VERSION } from './schema.mjs';

export const TEMPLATE = {
  schema: SCHEMA_VERSION,
  task_class: 'ui-new',
  forks: [],
  no_fork_reason: '把本行改成"为什么这次没有分叉"，或者填 forks',
};

// 字节级一致：init 写的就是这一串，check 比对的也是这一串。
export const TEMPLATE_TEXT = `${JSON.stringify(TEMPLATE, null, 2)}\n`;

export const templateHash = () => createHash('sha256').update(TEMPLATE_TEXT).digest('hex');

// 即使模型把文件重新序列化（缩进/换行变了），占位理由还在，就仍是"没申报"。
// 哈希抓字节，这一句抓语义上的模板。
export const isTemplateReason = (reason) => reason === TEMPLATE.no_fork_reason;
