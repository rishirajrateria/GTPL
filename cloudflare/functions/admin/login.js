import { login } from '../../lib/core.js';

export const onRequestPost = ({ request, env }) => login(request, env);
