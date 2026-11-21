// SSRF 防线。从 check.mjs 拆出来：那个文件被 20KB 提交钩子防线的 20KB 上限拒收，而这一块只关心
// "ctx.fetch 怎么把外发请求挡在内网之外"，与台账校验是两个关注点。
//
// ctx.fetch 是给台账里的 URL 回访用的，URL 由模型/用户填。默认 redirect: follow 会让一个
// 302 把请求送进内网；改成手动跟随，每跳都重新过主机检查。
//
// "什么算内网地址"只写一份（isPrivateAddress/isIntranetHost）：
//   - fetch 许可（isPrivateHost：允许直连用户的内网文档站，link-local/元数据除外）是许可语义；
//   - 来源分类（evidence.mjs 的 registrableDomain 把所有内网地址归并成同一票）是分类语义。
// 两种政策共用同一个地址集——两处各写一份迟早漂移（审查 2026-11-21：旧实现只认点分十进制，
// [::ffff:7f00:1] 这种 WHATWG 序列化直接漏过；URL 解析器会把 0x7f000001 这类变体规范成点分四段，
// 所以守卫真正要防的是序列化后的漏网形状）。

const norm = (s) => String(s ?? '').toLowerCase().replace(/^\[|\]$/g, '');

// '::ffff:127.0.0.1'（dotted）与 '::ffff:7f00:1'（WHATWG 对 [::ffff:127.0.0.1] 的序列化）
// → 点分四段数组；不是映射形式返回 null。
function mappedV4(s) {
  if (!s.startsWith('::ffff:')) return null;
  const tail = s.slice(7);
  if (!tail.includes(':')) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(tail);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
  }
  const grps = tail.split(':').filter(Boolean);
  if (grps.length < 2) return null;
  const hi = parseInt(grps[grps.length - 2], 16);
  const lo = parseInt(grps[grps.length - 1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

const v4of = (s) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
};

// 私网全集：环回、内网段、保留段 0.x、链路本地（含云元数据 169.254.169.254）。
function isPrivateV4([a, b]) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

// 不可直连的地址段：0.x（未指定/保留）与 link-local 169.254.x（含云元数据）。
// 环回/内网段是"用户自己的文档站"，直连许可按产品语义保留。
function unsafeV4([a, b]) {
  return a === 0 || (a === 169 && b === 254);
}

// 地址分类器：内网/环回/保留/链路本地/映射 v4 → true；公网地址与普通域名 → false。
// 域名的内网性不由字符串判定（要 DNS 回答），由 evidence 层的 DNS 归并处理。
export function isPrivateAddress(addr) {
  const s = norm(addr);
  if (!s) return true;
  if (s.includes(':')) {
    if (s === '::1' || s === '::') return true;
    if (/^fe[89ab]/.test(s)) return true; // v6 链路本地 fe80::/10
    if (/^f[cd]/.test(s)) return true; // ULA fc00::/7
    const v4 = mappedV4(s);
    return v4 ? isPrivateV4(v4) : false;
  }
  const v4 = v4of(s);
  return v4 ? isPrivateV4(v4) : false;
}

// 主机名级分类：环回名（localhost/*.localhost）、内网域名后缀（*.local）、
// 云元数据主机、内网地址都算内网。evidence 层把这一类归并成同一票。
export function isIntranetHost(host) {
  const h = norm(host);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === 'metadata.google.internal') return true;
  return isPrivateAddress(h);
}

// 直连许可：内网/环回是用户自己的文档站，允许；link-local（含云元数据）、
// 0.x/:: 这类"不指定"地址一律拒。重定向目标比直连严（isPrivateRedirectTarget）。
export function isPrivateHost(host) {
  const h = norm(host);
  if (!h || h === 'metadata.google.internal') return true;
  if (h.includes(':')) {
    if (h === '::' || /^fe[89ab]/.test(h)) return true;
    const v4 = mappedV4(h);
    return v4 ? unsafeV4(v4) : false;
  }
  const v4 = v4of(h);
  return v4 ? unsafeV4(v4) : false;
}

// 重定向目标比直连更严格：公网上一个 URL 不该把请求送进用户的内网/本机，
// 环回/私网/链路本地/元数据全拒（直连的许可政策不适用于被重定向的目标）。
export const isPrivateRedirectTarget = (host) => isIntranetHost(host);

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
