import { send } from '../../lib/core.js';

export const onRequestGet = () => send(200, { ok: true });
export const onRequestHead = onRequestGet;
