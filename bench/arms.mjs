// 真实模型对照跑的臂名与 silent 臂的预处理。
// 单独一个文件，是为了让"未知臂直接报错"和"指路段必须真的删掉"能单测——
// 这两处静默失败都会让整组对照数据失去意义（silent 退化成 on，或 typo 退化成 off）。

export const ARMS = ['off', 'on', 'silent'];

export function assertArm(protocol) {
  if (!ARMS.includes(protocol)) throw new Error(`未知 protocol：${protocol}（可选 ${ARMS.join(' / ')}）`);
  return protocol;
}

// silent 臂 = 仓库 init 过，但 agent 没读到协议。init 会把指路段写进 AGENTS.md，
// 这里把它删掉；正则改坏时必须抛错，否则 silent 会静默退化成 on。
export function stripProtocolPointer(text) {
  const stripped = String(text).replace(/<!-- claimrail:begin -->[\s\S]*?<!-- claimrail:end -->\n?/, '');
  if (stripped === text) throw new Error('AGENTS.md 的 claimrail 指路段没删掉，silent 臂会退化成 on');
  return stripped;
}
