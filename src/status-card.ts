import { z } from 'zod';
import { classifyText } from './content-safety.js';
import { BridgeError } from './types.js';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const plain = z.string().trim().min(1).max(800).refine(s => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s));
export const statusCardSchema = z.object({ binding_id: id, request_id: id, task_id: id,
  expected_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  status: z.enum(['processing','waiting_confirmation','completed','failed','blocked']),
  summary: plain, action: plain.optional(), reason: plain.optional(), existing_user_authorization: z.literal(true)
}).strict().superRefine((a, ctx) => {
  if (a.status === 'waiting_confirmation' && (!a.action || !a.reason)) ctx.addIssue({ code:'custom', message:'wait_requires_action_and_reason' });
  if (['failed','blocked'].includes(a.status) && !a.reason) ctx.addIssue({ code:'custom', message:'failure_requires_reason' });
});
export type StatusSubmission = z.infer<typeof statusCardSchema>;
export const labels = { processing:'处理中', waiting_confirmation:'等待确认', completed:'完成', failed:'失败', blocked:'阻塞' };
// Official product entry only; no guessed task/approval deep links or caller URL.
export const DOT_ENTRY = 'https://chatgpt.com/dots/home';
export function buildStatusCard(a: StatusSubmission) {
  for (const value of [a.summary,a.action,a.reason]) if (value && classifyText(value) === 'credential') throw new BridgeError('credential_blocked');
  const label = labels[a.status];
  const elements: unknown[] = [{ tag:'div', text:{ tag:'plain_text', content:a.summary } }];
  if (a.action) elements.push({ tag:'div', text:{ tag:'plain_text', content:'需要执行：' + a.action } });
  if (a.reason) elements.push({ tag:'div', text:{ tag:'plain_text', content:'原因：' + a.reason } });
  if (a.status === 'waiting_confirmation') {
    elements.push({ tag:'div', text:{ tag:'plain_text', content:'请打开 dot → Activity，检查对应请求并在原处确认。飞书点击只跳转，不授予 dot 权限。此状态由调用者提交。' } });
    elements.push({ tag:'button', text:{ tag:'plain_text', content:'打开 dot' }, type:'primary', behaviors:[{ type:'open_url', default_url:DOT_ENTRY }] });
  }
  return { schema:'2.0', config:{ update_multi:true, summary:{ content:label + ' · ' + Array.from(a.summary).slice(0,80).join('') + (Array.from(a.summary).length>80 ? '…' : '') } },
    header:{ title:{ tag:'plain_text', content:'dot · ' + label }, template:a.status === 'completed' ? 'green' : ['failed','blocked'].includes(a.status) ? 'red' : a.status === 'waiting_confirmation' ? 'orange' : 'blue' }, body:{ elements } };
}
