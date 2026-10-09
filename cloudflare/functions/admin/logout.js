import { logout } from '../../lib/core.js';

export const onRequestPost = ({ request }) => logout(request);
