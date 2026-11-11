// SSRF 防线。从 check.mjs 拆出来：那个文件被 20KB 提交钩子拒收，而这一块只关心
// "ctx.fetch 怎么把外发请求挡在内网之外"，与台账校验是两个关注点。
//
// ctx.fetch 是给台账里的 URL 用的，URL 由模型/用户填。默认 redirect: follow 会让一个
// 302 把请求送进内网；改成手动跟随，每跳都重新过主机检查。
export function isPrivateHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === '0.0.0.0' || h === '::') return true;
  if (h === 'metadata.google.internal' || h === '169.254.169.254') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // link-local（含云元数据）一律拒；其它私网/loopback 是用户自己的文档站，允许直连
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  return false;
}

// 重定向目标比直连更严格：公网上一个 URL 不该把请求送进用户的内网/本机。
export function isPrivateRedirectTarget(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (h === 'metadata.google.internal' || h === '169.254.169.254') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

export async function fetchWithRedirects(url, allowNet, fetchImpl = globalThis.fetch) {
  if (!allowNet) return null;
  let current = url;
  if (isPrivateHost(new URL(current).hostname)) throw new Error('私网/元数据地址，已拒绝');
  for (let i = 0; i < 5; i += 1) {
    const res = await fetchImpl(current, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
      headers: { 'accept-language': 'en' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, text: '' };
      const next = new URL(loc, current);
      if (isPrivateRedirectTarget(next.hostname)) throw new Error('重定向指向私网/元数据地址，已拒绝');
      current = next.href;
      continue;
    }
    return { status: res.status, text: await res.text() };
  }
  throw new Error('重定向次数过多');
}
