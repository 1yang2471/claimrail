// 台账与 baseline 的路径。单独一个文件，是为了让 args.mjs 与 cli.mjs 共用同一份定义，
// 不出现两处手写的 '.claimrail/decisions.json'。
import { join } from 'node:path';

export const LEDGER_PATH = join('.claimrail', 'decisions.json');
export const BASELINE_PATH = join('.claimrail', 'baseline');
export const TEMPLATE_HASH_PATH = join('.claimrail', 'template.sha256');
// 上次放行时的 {tree_hash, ledger_hash}；本地状态，不进 git。
export const SNAPSHOT_PATH = join('.claimrail', 'last-delivery.json');
// 第二次放行仍未申报的逃逸记录；本地状态，不进 git。
export const VIOLATIONS_PATH = join('.claimrail', 'violations.jsonl');
