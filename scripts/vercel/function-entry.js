// Vercel Node.js function. The Build Output API copies this to
// .vercel/output/functions/api.func/index.js next to the api/ sources.
import { handleRequest } from './server.js';

export default function handler(req, res) {
  return handleRequest(req, res);
}
