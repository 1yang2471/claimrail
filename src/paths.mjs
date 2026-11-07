// 台账与 baseline 的路径。单独一个文件，是为了让 args.mjs 与 cli.mjs 共用同一份定义，
// 不出现两处手写的 '.forklight/decisions.json'。
import { join } from 'node:path';

export const LEDGER_PATH = join('.forklight', 'decisions.json');
export const BASELINE_PATH = join('.forklight', 'baseline');
