// Status and note changes from the leads table.
import { updateLead } from '../../../lib/core.js';

export const onRequestPost = ({ request, env }) => updateLead(request, env);
