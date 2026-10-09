// /admin: the sign-in page, or the dashboard once signed in.
import { adminPage } from '../../lib/core.js';

export const onRequestGet = ({ request, env }) => adminPage(request, env);
export const onRequestHead = onRequestGet;
