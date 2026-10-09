// CSV download (Excel opens it). The URL avoids ".csv" on purpose.
import { exportCsv, rangeArgs, send } from '../../../lib/core.js';

export async function onRequestGet({ request, env }) {
  const [frm, to] = rangeArgs(new URL(request.url));
  return send(200, await exportCsv(env, frm, to), {
    type: 'text/csv', admin: true,
    headers: { 'Content-Disposition': `attachment; filename="ill-leads-${frm}-to-${to}.csv"` },
  });
}
