import { rangeArgs, ReportLimit, send, summary } from '../../../lib/core.js';

export async function onRequestGet({ request, env }) {
  const [frm, to] = rangeArgs(new URL(request.url));
  try {
    return send(200, await summary(env, frm, to), { admin: true });
  } catch (e) {
    // The day's report allowance is spent: say so, instead of a generic error. Leads are unaffected.
    if (e instanceof ReportLimit) return send(429, { error: 'report-limit' }, { admin: true });
    throw e;
  }
}
