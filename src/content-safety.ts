/**
 * Conservative, local-only gate for text mirroring. Call before storing, logging,
 * queueing, or forwarding text in EITHER direction. Never log rejected text.
 *
 * This is a heuristic, not a secret scanner or a security guarantee. It can reject
 * harmless examples and Luhn-valid numbers. It cannot recognize every
 * unlabelled password, recovery phrase, novel credential format, encoding, or
 * deliberate obfuscation. `ordinary` means no supported signal was found, NOT that
 * the text is proven safe. It does not authorize additional data sharing.
 *
 * Normalization is for inspection only; callers must never send the normalized
 * copy. No matched value, snippet, or reason containing input is returned.
 */

const CONFUSABLES: Readonly<Record<string, string>> = {
  'а': 'a', 'А': 'A', 'ɑ': 'a', 'Α': 'A', 'е': 'e', 'Е': 'E', 'Ε': 'E',
  'і': 'i', 'І': 'I', 'Ι': 'I', 'ı': 'i', 'ј': 'j', 'Ј': 'J', 'κ': 'k',
  'Κ': 'K', 'К': 'K', 'М': 'M', 'Μ': 'M', 'о': 'o', 'О': 'O', 'Ο': 'O',
  'ο': 'o', 'р': 'p', 'Р': 'P', 'Ρ': 'P', 'ρ': 'p', 'с': 'c', 'С': 'C',
  'ϲ': 'c', 'Ϲ': 'C', 'ѕ': 's', 'Ѕ': 'S', 'Τ': 'T', 'Т': 'T', 'х': 'x',
  'Х': 'X', 'Χ': 'X', 'χ': 'x', 'у': 'y', 'У': 'Y', 'Υ': 'Y', 'ν': 'v'
};

function codePoint(value: string, radix: number, fallback: string): string {
  const number = Number.parseInt(value, radix);
  return number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
    ? String.fromCodePoint(number) : fallback;
}

function normalize(text: string): string {
  // Bounded passes handle common nested percent/entity/escaped representations;
  // arbitrary encoding layers intentionally are not promised to be detectable.
  let result = text;
  for (let pass = 0; pass < 3; pass++) {
    result = result.normalize('NFKC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
      .replace(/(?:%[0-9a-f]{2})+/gi, value => {
        try { return decodeURIComponent(value); } catch {
          // A malformed byte must not hide adjacent ASCII-encoded labels.
          return value.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => {
            const byte = Number.parseInt(hex, 16);
            return byte < 0x80 ? String.fromCharCode(byte) : '\ufffd';
          });
        }
      })
      .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi,
        (whole: string, hex: string | undefined, decimal: string | undefined) =>
          codePoint(hex ?? decimal!, hex ? 16 : 10, whole))
      .replace(/&(colon|equals|commat|amp|quot|apos|nbsp);/gi, (_whole, name: string) =>
        ({ colon: ':', equals: '=', commat: '@', amp: '&', quot: '"', apos: "'", nbsp: ' ' })[name.toLowerCase()]!)
      .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
        (whole: string, braced: string | undefined, unicode: string | undefined, hex: string | undefined) =>
          codePoint(braced ?? unicode ?? hex!, 16, whole));
  }
  return result.normalize('NFKD').replace(/\p{Default_Ignorable_Code_Point}|\p{M}/gu, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, value => String(value.charCodeAt(0) & 15))
    .replace(/[^\x00-\x7f]/gu, value => CONFUSABLES[value] ?? value);
}

const LABEL = String.raw`(?:password|passwd|pwd|passphrase|api[ _-]?key|(?:api|access|refresh|session|auth|authentication|authorization|id|bearer)[ _-]?token|token|(?:api|client|app|application|signing|webhook|payment)[ _-]?secret|(?:secret|private|storage|encryption|service[ _-]?role)[ _-]?key|bridge[ _-]?token|session[ _-]?id|(?:recovery|backup)[ _-]?(?:code|key)s?|(?:seed|recovery|mnemonic)[ _-]?phrase|otp|totp|(?:one[ _-]?time|verification|security|2fa|mfa)[ _-]?(?:password|passcode|code)|pin|cvv|cvc|card[ _-]?(?:number|security[ _-]?code)|密码|密碼|口令|密钥|密鑰|(?:访问|訪問|会话|會話|刷新|授权|授權)令牌|(?:恢复|恢復|备用|備用)码|(?:恢復|備用)碼|验证码|驗證碼|动态码|動態碼|安全码|安全碼|支付密码|支付密碼|助记词|助記詞)`;
const LABEL_VALUE = new RegExp(
  String.raw`(?:^|[^a-z0-9])(${LABEL})["'\x60]?\s{0,24}(?:(:|=|：|为|為|是)|\b(is|equals)\b)\s{0,24}(?=([^\r\n]{1,256}))`, 'gim');
const LABEL_SPACE_VALUE = new RegExp(
  String.raw`(?:^|[^a-z0-9])(${LABEL})[ \t]{1,8}([^\s,;]{1,256})`, 'gim');
const NUMERIC_LABEL_VALUE = new RegExp(
  String.raw`(?:^|[^a-z0-9])(?:otp|totp|pin|cvv|cvc|(?:verification|security|2fa|mfa)[ _-]?code|验证码|驗證碼|动态码|動態碼|安全码|安全碼)[ \t]{0,8}(?:code[ \t]{0,8})?(?:(?:[:=]|是|为|為|\bis\b|\bequals\b)[ \t]{0,8})?(\d[\d -]{2,18}\d)(?!\d)`, 'gim');

// Only explicit placeholders or descriptions of absent/required values are
// exempted. Quoted literal words such as password="missing" remain blocked.
function hasLiteralValue(tail: string): boolean {
  const value = tail.trim();
  if (/^(?:["'`]?\s*)?(?:<(?:YOUR_)?(?:API_KEY|PASSWORD|TOKEN|SECRET|VALUE)>|\$\{[A-Z0-9_]+\}|\[(?:redacted|hidden|removed)\]|\*{3,})(?:["'`]?)(?=$|[\s,;.])/i.test(value)) return false;
  if (/^["'`]/.test(value)) return !/^["'`]\s*["'`](?=$|[\s,;.])/.test(value);
  if (/^(?:required|needed|missing|unset|undefined|null|empty|redacted|hidden|removed|optional|expired|invalid|incorrect|wrong|unchanged|unknown|unavailable|valid|active|enabled|disabled|revoked|rotated|not\s+(?:set|required|provided|available)|never\s+(?:shared|logged|stored)|too\s+(?:short|long|weak)|a\s+(?:secret|string|credential)|used\s+(?:for|to)|stored\s+(?:in|locally)|已隐藏|已隱藏|已删除|已刪除|未设置|未設置|为空|為空|必填|错误|錯誤|无效|無效)(?=$|[\s,;.!。])/i.test(value)) return false;
  return /[^\s,;:.!。]/.test(value);
}

function hasPaymentNumber(text: string): boolean {
  for (const match of text.matchAll(/(?:^|[^a-z0-9])((?:\d[ -]?){12,18}\d)(?![ -]?\d|[a-z0-9])/gi)) {
    const digits = match[1]!.replace(/\D/g, '');
    // Known card-number leading ranges; arbitrary numeric IDs are not proof of
    // payment data, but a matching length/range/checksum is conservatively held.
    if (!/^(?:4|5[1-5]|2[2-7]|3[47]|6)/.test(digits)) continue;
    let sum = 0;
    for (let index = digits.length - 1, double = false; index >= 0; index--, double = !double) {
      let digit = Number(digits[index]);
      if (double) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** Returns only a generic classification; no input-derived diagnostic escapes. */
export function classifyText(text: string): 'ordinary' | 'credential' {
  const normalized = normalize(text);
  if (/-----\s*begin\s+(?:(?:rsa|ec|dsa|openssh|encrypted|pgp)\s+)?private\s+key(?:\s+block)?\s*-----/i.test(normalized)) return 'credential';
  if (/(?:^|[^a-z0-9])(?:sk-(?:(?:proj|ant(?:-api\d+)?)-)?[a-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[a-z0-9]{12,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{16,}|xox[baprs]-[a-z0-9-]{12,}|(?:whsec|npm)_[a-z0-9+/=_-]{16,}|AIza[a-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16})(?![a-z0-9])/i.test(normalized)) return 'credential';
  if (/(?:^|[^a-z0-9_-])eyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?![a-z0-9_-])/i.test(normalized)) return 'credential';
  if (/\b(?:bearer\s+[a-z0-9._~+/-]{6,}={0,2}|(?:authorization|proxy-authorization)\s*:\s*basic\s+[a-z0-9+/]{8,}={0,2})/i.test(normalized)) return 'credential';
  if (/(?:^|[\s;])(?:__secure-|__host-)?(?:session(?:id|_id|_token)?|sid|connect\.sid|auth(?:_token)?|jwt)\s*=\s*["']?[^\s;'",]{4,}/i.test(normalized)) return 'credential';

  // Inspect URLs without fetching or parsing remote content. Includes database
  // connection strings, percent-encoded userinfo, query credentials and fragments.
  for (const match of normalized.matchAll(/[a-z][a-z0-9+.-]{1,24}:\/\/[^\s<>"']+/gi)) {
    const url = match[0];
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]+@/i.test(url)) return 'credential';
    if (/[?#&;](?:access_token|refresh_token|id_token|session_token|token|api[_-]?key|key|secret|client_secret|password|passwd|pwd|auth|authorization|signature|sig|x-amz-signature|x-amz-credential|x-goog-signature|code)=[^&#;\s]+/i.test(url)) return 'credential';
    if (/\/(?:reset(?:-password)?|password-reset|magic-link|verify-email)\/[a-z0-9_-]{12,}/i.test(url)) return 'credential';
  }
  // New RegExp instances avoid shared lastIndex state across calls.
  for (const match of normalized.matchAll(new RegExp(LABEL_VALUE))) {
    if (hasLiteralValue(match[4]!)) return 'credential';
  }
  for (const match of normalized.matchAll(new RegExp(LABEL_SPACE_VALUE))) {
    const value = match[2]!.replace(/[.,:;!?，。！？：；]+$/g, '');
    if (hasLiteralValue(value) && (/[0-9]/.test(value) || /[^\p{L}\p{N}]/u.test(value) || value.length >= 16)) return 'credential';
  }
  if (new RegExp(NUMERIC_LABEL_VALUE).test(normalized) || hasPaymentNumber(normalized)) return 'credential';
  // Deliberately do not infer credentials from entropy alone: source IDs,
  // diagnostic hashes, and trace IDs are ordinary troubleshooting content.
  return 'ordinary';
}
