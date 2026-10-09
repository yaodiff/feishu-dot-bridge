/** Synthetic examples only; no service, credentials, network, or runtime state. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyText } from '../src/content-safety.js';

const blocked: ReadonlyArray<readonly [string, string]> = [
  ['password assignment', 'password = SYNTHETIC_ONLY_42!'],
  ['short password', 'pwd: x'],
  ['quoted password', 'The password is "synthetic only"'],
  ['literal status word password', 'password="missing"'],
  ['JSON API key', '{"api_key": "SYNTHETIC_ONLY_42"}'],
  ['environment client secret', 'CLIENT_SECRET=SYNTHETIC_ONLY'],
  ['session token', 'session_token: SYNTHETIC_ONLY'],
  ['access token', 'access token is SYNTHETIC_ONLY'],
  ['generic token assignment', 'token = SYNTHETIC_ONLY'],
  ['API secret', 'api_secret = SYNTHETIC_ONLY'],
  ['refresh token', 'refresh-token=SYNTHETIC_ONLY'],
  ['private key label', 'private key: SYNTHETIC_ONLY'],
  ['storage key', 'STORAGE_KEY=SYNTHETIC_ONLY'],
  ['bridge token', 'BRIDGE_TOKEN=SYNTHETIC_ONLY'],
  ['webhook secret', 'webhook_secret: SYNTHETIC_ONLY'],
  ['bare labelled mixed password', 'password Synthetic42Only'],
  ['bare labelled long password', 'password syntheticwordsonly'],
  ['Chinese password', '密码：仅供测试123'],
  ['Chinese password sentence', '我的密码是仅供测试'],
  ['traditional password', '密碼為僅供測試'],
  ['Chinese API secret', '密钥=仅供测试'],
  ['Chinese access token', '访问令牌：SYNTHETIC_ONLY'],
  ['OTP numeric', 'OTP: 000123'],
  ['OTP mention with value', 'My OTP is 000123'],
  ['OTP whitespace', 'OTP 000123'],
  ['OTP code wording', 'OTP code is 000123'],
  ['OTP phrase', 'one-time code = 000123'],
  ['Chinese OTP', '验证码 000123'],
  ['Chinese spaced OTP', '验证码是 00 01 23'],
  ['traditional OTP', '驗證碼：000123'],
  ['recovery codes', 'backup codes: SYNTH-ONLY-0001'],
  ['recovery phrase', 'seed phrase: synthetic example words only'],
  ['Chinese recovery phrase', '助记词：仅供测试的词'],
  ['PIN', 'PIN=0000'],
  ['CVV', 'cvv: 000'],
  ['CVC whitespace', 'cvc 000'],
  ['card test number', '4111 1111 1111 1111'],
  ['card dashed test number', '4111-1111-1111-1111'],
  ['card labelled invalid number', 'card number: 4111111111111112'],
  ['payment secret', 'payment_secret = SYNTHETIC_ONLY'],
  ['PEM private key header', '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_ONLY'],
  ['RSA private key header', '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_ONLY'],
  ['PGP private key header', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nSYNTHETIC_ONLY'],
  ['OpenSSH private key header', '-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC_ONLY'],
  ['encrypted private key header', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nSYNTHETIC_ONLY'],
  ['synthetic OpenAI-shaped token', 'sk-proj-SYNTHETIC_ONLY_000000000000'],
  ['synthetic GitHub-shaped token', 'ghp_SYNTHETICONLY000000000000'],
  ['synthetic GitHub PAT', 'github_pat_SYNTHETIC_ONLY_000000000000'],
  ['synthetic GitLab-shaped token', 'glpat-SYNTHETIC_ONLY_000000000000'],
  ['synthetic Slack-shaped token', 'xoxb-SYNTHETIC-ONLY-00000000'],
  ['synthetic AWS-shaped key', 'AKIA0000000000000000'],
  ['synthetic signing secret', 'whsec_SYNTHETIC_ONLY_000000000000'],
  ['synthetic payment API key', 'sk_test_SYNTHETIC00000000'],
  ['synthetic JWT structure', 'eyJTWU5USEVUSUM.QU5EX09OTFlfMDAw.U1lOVEhFVElDT05MWQ'],
  ['bearer header', 'Authorization: Bearer SYNTHETIC_ONLY_000000'],
  ['bare bearer', 'Bearer SYNTHETIC_ONLY_000000'],
  ['basic header', 'Authorization: Basic U1lOVEhFVElDOk9OTFk='],
  ['cookie', 'Cookie: sessionid=SYNTHETIC_ONLY_000000'],
  ['secure cookie', 'Set-Cookie: __Secure-session=SYNTHETIC_ONLY_000000; HttpOnly'],
  ['URL password', 'https://synthetic:only@example.invalid/path'],
  ['database URL', 'postgres://synthetic:only@example.invalid/db'],
  ['URL query token', 'https://example.invalid/path?token=SYNTHETIC_ONLY'],
  ['URL fragment token', 'https://example.invalid/#access_token=SYNTHETIC_ONLY'],
  ['URL signed query', 'https://example.invalid/?X-Amz-Signature=SYNTHETIC_ONLY'],
  ['URL OAuth code', 'https://example.invalid/callback?code=SYNTHETIC_ONLY'],
  ['URL encoded query key', 'https://example.invalid/?%61pi%5fkey=SYNTHETIC_ONLY'],
  ['URL encoded userinfo', 'https://synthetic%3Aonly%40example.invalid/'],
  ['URL nested encoding', 'https://example.invalid/?%2574oken=SYNTHETIC_ONLY'],
  ['magic link', 'https://example.invalid/magic-link/SYNTHETIC_ONLY_000'],
  ['fullwidth', 'ｐａｓｓｗｏｒｄ＝ＳＹＮＴＨＥＴＩＣ＿ＯＮＬＹ'],
  ['zero-width label', 'pass\u200bword=SYNTHETIC_ONLY'],
  ['zero-width value', 'api_key=\u200dSYNTHETIC_ONLY'],
  ['bidi control', 'pass\u202eword=SYNTHETIC_ONLY'],
  ['Cyrillic homoglyph', 'pаsswоrd=SYNTHETIC_ONLY'],
  ['combining marks', 'pa\u0301ssword=SYNTHETIC_ONLY'],
  ['Unicode escaped label', '\\u0070assword=SYNTHETIC_ONLY'],
  ['HTML encoded separator', 'password&#x3d;SYNTHETIC_ONLY'],
  ['HTML named separator', 'password&equals;SYNTHETIC_ONLY'],
  ['Arabic digit OTP', 'OTP ٠٠٠١٢٣'],
  ['multiple statements', 'password is required.\npassword=SYNTHETIC_ONLY'],
  ['multiple assignments on one line', 'password is required, password=SYNTHETIC_ONLY'],
  ['angle wrapped actual value', 'password: <SYNTHETIC_ONLY>'],
  ['adjacent malformed percent encoding', '%FF%70assword=SYNTHETIC_ONLY'],
  ['empty then actual password', 'password: \npassword=SYNTHETIC_ONLY'],
];

for (const [description, text] of blocked) test(`blocks ${description}`, () => {
  assert.equal(classifyText(text), 'credential');
});

const ordinary: ReadonlyArray<readonly [string, string]> = [
  ['empty', ''],
  ['ordinary English', 'Please send me the meeting notes tomorrow'],
  ['ordinary Chinese', '明天早上九点开会，记得带电脑'],
  ['API discussion', 'The API supports pagination and webhook callbacks'],
  ['password discussion', 'Please rotate your password and never send it here'],
  ['password reset discussion', 'I forgot my password. How do I reset it?'],
  ['password question', 'Can you explain password reset?'],
  ['API key discussion', 'Where should the API key be stored?'],
  ['password requirement', 'The password is required'],
  ['password status', 'password: missing'],
  ['empty password', 'password=""'],
  ['blank password', 'password:   '],
  ['credential placeholder', 'API_KEY=${API_KEY}'],
  ['redacted password', 'password: [REDACTED]'],
  ['masked password', 'password: ********'],
  ['angle placeholder', 'api key: <API_KEY>'],
  ['OTP discussion', 'Never share an OTP or verification code'],
  ['OTP duration', 'The OTP expires in 30 seconds'],
  ['OTP longer duration', 'The OTP expires in 3600 seconds'],
  ['OTP length', 'An OTP has 6 digits'],
  ['OTP status', 'The one-time code is valid'],
  ['password length', 'The password is too short'],
  ['policy', 'Password policy: use 12 characters or more'],
  ['Chinese password discussion', '请不要在这里分享密码，也不要发送验证码'],
  ['Chinese password status', '密码：未设置'],
  ['public key', '-----BEGIN PUBLIC KEY-----\nSYNTHETIC_PUBLIC_DATA'],
  ['ordinary URL', 'https://example.invalid/docs/api?version=2'],
  ['username-only URL', 'https://synthetic@example.invalid/'],
  ['empty token URL', 'https://example.invalid/?token='],
  ['hash', 'Commit abcdef0123456789abcdef0123456789abcdef01'],
  ['SHA256', 'SHA256 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234'],
  ['hash containing card-shaped digits', 'SHA256 abcdefabcdefabcdefabcdef4111111111111111abcdefabcdefabcdefabcdef'],
  ['opaque diagnostic ID', 'Trace SYNTHETICabCD09efGH18ijKL27mnOP36'],
  ['base64 source ID', 'source ID U1lOVEhFVElDX1NPVVJDRV9JRF9PTkxZXzEyMw=='],
  ['UUID', 'ID 00112233-4455-6677-8899-aabbccddeeff'],
  ['phone', 'Call 020 7946 0000'],
  ['timestamp', '2026-10-08T07:00:00Z'],
  ['invalid unlabelled card number', '4111 1111 1111 1112'],
];

for (const [description, text] of ordinary) test(`allows ${description}`, () => {
  assert.equal(classifyText(text), 'ordinary');
});

test('classification is deterministic, returns no snippets, and has no shared regex state', () => {
  for (let index = 0; index < 20; index++) {
    assert.equal(classifyText('password=SYNTHETIC_ONLY'), 'credential');
    assert.equal(classifyText('The API supports webhooks'), 'ordinary');
  }
});

test('malformed encodings do not throw or hide later labelled content', () => {
  assert.equal(classifyText('%FF &#x110000; \\u{ffffff} password=SYNTHETIC_ONLY'), 'credential');
  assert.equal(classifyText('%FF &#x110000; \\u{ffffff} no value here'), 'ordinary');
});

test('bounded scanning handles long ordinary text and a credential near its end', () => {
  const text = 'ordinary meeting notes '.repeat(10_000);
  assert.equal(classifyText(text), 'ordinary');
  assert.equal(classifyText(text + 'password=SYNTHETIC_ONLY'), 'credential');
});

test('documented limitation: an unlabelled simple password is not distinguishable from prose', () => {
  assert.equal(classifyText('syntheticwordsonly'), 'ordinary');
});
