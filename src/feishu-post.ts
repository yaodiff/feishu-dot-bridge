/** Bounded plain-text compatibility for authenticated Feishu post content.
 * Links/mentions/unknown text are data, never instructions or network targets. */
import { classifyText } from './content-safety.js';
import { parseMediaReference, type MediaReference } from './media-policy.js';
import type { ContentStatus } from './types.js';
export const POST_LIMITS = Object.freeze({ rawChars: 64000, textChars: 12000, images: 4, rows: 128, nodes: 512, depth: 12, values: 2048, locales: 4, mentions: 128 });
export interface PostContent { text: string; contentStatus?: ContentStatus; postImages?: readonly MediaReference[] }
const hasPairingCommand = (text: string) => /\/bind\s+[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/i.test(text);
const blocked = (): PostContent => ({ text: '[未同步：消息可能包含登录凭据或其他密钥]', contentStatus: 'credential_blocked' });
const omitted = (reason: 'invalid' | 'limits'): PostContent => ({ text: reason === 'invalid' ? '[未同步：富文本结构无法解析，消息未截断转发]' : '[未同步：富文本超过处理上限，消息未截断转发]' });
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const hiddenNames = new Set(['tag','style','unescape','imagekey','filekey','mediakey','resourcekey','imagekeys','filekeys','resourcekeys','key','width','height','userid','id','token','resourceurl','downloadurl','localpath','resourcepath']);
const hiddenKey = (key: string) => hiddenNames.has(key.replace(/[_-]/g, '').toLowerCase());
class PostLimit extends Error {}
// Only the observed content_v2 compatibility alias is eligible. Arrays retain
// order; object property order is immaterial. Scan limits already bound recursion.
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && sameJsonValue(left[key], right[key]));
}

export function parseFeishuPost(raw: string, allowImages: boolean, mentions?: unknown): PostContent {
  if (raw.length > POST_LIMITS.rawChars) return omitted('limits');
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return omitted('invalid'); }
  if (!object(data)) return omitted('invalid');
  // Inspect all values, including nonselected/malformed/unknown nodes, before
  // returning any image reference. Rendered text is gated again for split labels.
  const strings: string[] = []; let values = 0, stringChars = 0;
  const scan = (value: unknown, depth = 0): void => {
    if (depth > POST_LIMITS.depth || ++values > POST_LIMITS.values) throw new PostLimit();
    if (typeof value === 'string') { stringChars += value.length; if (stringChars > POST_LIMITS.rawChars * 2) throw new PostLimit(); strings.push(value); }
    else if (Array.isArray(value)) for (const child of value) scan(child, depth + 1);
    else if (object(value)) for (const child of Object.values(value)) scan(child, depth + 1);
  };
  try { scan(data); if (mentions !== undefined) scan(mentions); } catch { return omitted('limits'); }
  if (hasPairingCommand(raw) || strings.some(hasPairingCommand) || classifyText(raw) === 'credential' || classifyText(strings.join('\n')) === 'credential') return blocked();
  const names = new Map<string, string>();
  if (Array.isArray(mentions)) {
    if (mentions.length > POST_LIMITS.mentions) return omitted('limits');
    for (const mention of mentions) if (object(mention) && typeof mention.name === 'string') {
      if (typeof mention.key === 'string') names.set(mention.key, mention.name);
      if (object(mention.id)) for (const key of ['open_id','user_id','union_id']) if (typeof mention.id[key] === 'string') names.set(mention.id[key] as string, mention.name);
    }
  }
  const refs: MediaReference[] = []; let nodeCount = 0, imageCount = 0;
  // Only textual fields of unknown nodes are preserved; resource/style fields
  // remain omitted under an explicit marker. Never serialize raw node objects.
  const fallback = (value: unknown, depth = 0): string => {
    if (depth > POST_LIMITS.depth) throw new PostLimit();
    if (typeof value === 'string') return /^(?:img|file)_[A-Za-z0-9_-]{1,240}$/.test(value.trim()) ? '[资源引用已省略]' : value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(v => fallback(v, depth + 1)).filter(Boolean).join('\n');
    if (object(value)) return Object.entries(value).filter(([key]) => !hiddenKey(key)).map(([,v]) => fallback(v, depth + 1)).filter(Boolean).join('\n');
    return '';
  };
  const render = (node: unknown): string => {
    if (++nodeCount > POST_LIMITS.nodes) throw new PostLimit();
    if (!object(node)) return '[未支持的富文本节点]' + fallback(node);
    const tag = typeof node.tag === 'string' ? node.tag : '';
    const text = typeof node.text === 'string' ? node.text : undefined;
    let output: string, handled: string[];
    switch (tag) {
      case 'text': case 'md': case 'code':
        output = text ?? '[未同步：文本节点缺少文本]'; handled = ['text']; break;
      case 'a': {
        const href = typeof node.href === 'string' ? node.href : '';
        output = href ? text ? `${text} (${href})` : href : `${text ?? ''}[未同步：链接地址缺失]`; handled = ['text','href']; break;
      }
      case 'at': {
        const uid = typeof node.user_id === 'string' ? node.user_id : '';
        const name = typeof node.user_name === 'string' ? node.user_name : names.get(uid);
        output = '@' + (name || (uid === 'all' || uid === '@_all' ? 'all' : uid || '[未识别成员]')); handled = ['user_name']; break;
      }
      case 'img': {
        imageCount++;
        const parsed = parseMediaReference('image', JSON.stringify({ image_key: node.image_key }));
        if (!parsed.supported) output = `[未同步：第 ${imageCount} 张图片引用无效]`;
        else if (!allowImages) output = `[图片 ${imageCount}：图片读取未启用]`;
        else if (refs.length >= POST_LIMITS.images) output = `[未同步：第 ${imageCount} 张图片超过 ${POST_LIMITS.images} 张处理上限]`;
        else { refs.push(parsed.reference); output = `[图片 ${refs.length}]`; }
        handled = []; break;
      }
      case 'br': output = '\n'; handled = []; break;
      case 'hr': output = '\n[分隔线]\n'; handled = []; break;
      case 'emotion': output = text ?? (typeof node.emoji_type === 'string' ? `[表情：${node.emoji_type}]` : '[表情]'); handled = ['text','emoji_type']; break;
      case 'code_block': {
        const body = typeof node.content === 'string' ? node.content : text;
        output = (typeof node.language === 'string' ? `[代码语言：${node.language}]\n` : '') + (body ?? '[未同步：代码块缺少文本]');
        if (typeof node.content === 'string' && text !== undefined && text !== node.content) output += '\n[代码块附加文本]' + text;
        handled = ['content','text','language']; break;
      }
      default: return '[未支持的富文本节点，保留其文字；非文本部分未同步]' + fallback(node);
    }
    const malformed = handled.filter(key => node[key] !== undefined && typeof node[key] !== 'string');
    if (malformed.length) output += '[节点字段格式异常，保留可读取文字]' + malformed.map(key => fallback(node[key])).join('\n');
    const extras = Object.fromEntries(Object.entries(node).filter(([key]) => !hiddenKey(key) && !handled.includes(key)));
    if (Object.keys(extras).length) output += '[节点附加内容，非标准部分未同步]' + fallback(extras);
    return output;
  };
  const section = (value: unknown): string => {
    if (!object(value) || !Array.isArray(value.content) || (value.title !== undefined && typeof value.title !== 'string')) throw new Error('invalid');
    if (value.content.length > POST_LIMITS.rows) throw new PostLimit();
    const rows = value.content.map(row => { if (!Array.isArray(row)) return '[未支持的富文本行]' + fallback(row); return row.map(render).join(''); });
    const parts = [typeof value.title === 'string' ? value.title : '', rows.join('\n')];
    // Some official received posts repeat the exact row representation here.
    // Suppress only that alias and only exact structural equality, after the
    // whole-message credential scan. Differing/malformed values stay explicit.
    const duplicateV2 = own(value, 'content_v2') && Array.isArray(value.content_v2) && sameJsonValue(value.content, value.content_v2);
    const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !['title','content'].includes(key) && !(key === 'content_v2' && duplicateV2)));
    if (Object.keys(extra).length) parts.push('[富文本附加内容，非文本部分未同步]' + fallback(extra));
    return parts.filter((part,index) => index !== 0 || part !== '').join('\n');
  };
  let text: string;
  try {
    if (own(data,'content')) text = section(data);
    else {
      const locales = Object.entries(data).filter(([key]) => /^[a-z]{2}_[a-z]{2}$/.test(key));
      if (!locales.length) return omitted('invalid');
      if (locales.length > POST_LIMITS.locales) throw new PostLimit();
      text = locales.map(([locale,value]) => `${locales.length > 1 ? `[语言：${locale}]\n` : ''}${section(value)}`).join('\n');
      const extra = Object.fromEntries(Object.entries(data).filter(([key]) => !/^[a-z]{2}_[a-z]{2}$/.test(key)));
      if (Object.keys(extra).length) text += '\n[富文本附加内容，非文本部分未同步]' + fallback(extra);
    }
    if (!text) text = '[空富文本消息]';
    if (text.length > POST_LIMITS.textChars) throw new PostLimit();
  } catch (error) { return omitted(error instanceof PostLimit ? 'limits' : 'invalid'); }
  if (hasPairingCommand(text) || classifyText(text) === 'credential') return blocked();
  return { text, ...(refs.length ? { postImages: Object.freeze(refs) } : {}) };
}
