// 真实模型对照跑的臂名、臂语义与 silent 臂的预处理。
// 单独一个文件，是为了让"未知臂直接报错"和"指路段必须真的删掉"能单测——
// 这两处静默失败都会让整组对照数据失去意义（silent 退化成 on，或 typo 退化成 off）。
import { stripAgentsBlock } from '../src/agents.mjs';

export const ARM_NAMES = ['off', 'on', 'silent'];

// FK_ARMS="off, silent" 这种带空格的写法是自然写法，不能让它变成"未知 protocol： silent"。
export const parseArms = (raw) => {
  const list = String(raw ?? 'off,on')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['off', 'on'];
};

// 臂语义只住一处：run-real 不再自己写 protocol === 'on' || protocol === 'silent'。
export const usesInit = (protocol) => protocol === 'on' || protocol === 'silent';
export const usesProtocolPrompt = (protocol) => protocol === 'on';
export const stripsPointer = (protocol) => protocol === 'silent';

export function assertArm(protocol) {
  if (!ARM_NAMES.includes(protocol)) throw new Error(`未知 protocol：${protocol}（可选 ${ARM_NAMES.join(' / ')}）`);
  return protocol;
}

// silent 臂 = 仓库 init 过，但 agent 没读到协议。init 会把指路段写进 AGENTS.md，
// 这里把它删掉；标记常量与 cli 共用，正则改坏时必须抛错，否则 silent 会静默退化成 on。
export function stripProtocolPointer(text) {
  try {
    return stripAgentsBlock(text);
  } catch {
    throw new Error('AGENTS.md 的 claimrail 指路段没删掉，silent 臂会退化成 on');
  }
}
