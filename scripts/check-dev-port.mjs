/**
 * Refuses to start a second dev server against the same build directory.
 *
 * When port 3000 is taken, Next does not stop — it moves to 3001 and keeps going. That is
 * convenient for unrelated projects and actively harmful here, because the second server
 * shares `.next` with the first. Two Turbopack processes writing one build directory
 * corrupt each other's chunks, and the symptom is a 500 on every route, including API
 * routes that render no React at all. Nothing in that symptom points at "you have two
 * servers running", so the time goes on the application instead.
 *
 * Failing fast with the pid is the whole fix: it names the real problem at the moment it
 * is cheap to fix, rather than letting it surface later as an unexplained server error.
 *
 * Set DARB_ALLOW_SECOND_DEV=1 to override — a second server is fine if it has its own
 * NEXT_DIST_DIR, which is how the production build already stays out of the way.
 */
import { createServer } from 'node:net';
import { execSync } from 'node:child_process';

const port = Number(process.env.PORT ?? 3000);

if (process.env.DARB_ALLOW_SECOND_DEV === '1') {
  process.exit(0);
}

const probe = createServer();

probe.once('error', (error) => {
  if (error.code !== 'EADDRINUSE') {
    // Anything else is not ours to interpret; let `next dev` report it.
    process.exit(0);
  }

  let owner = '';
  try {
    owner = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .join(', ');
  } catch {
    // lsof is absent or returned nothing; the message is still useful without a pid.
  }

  console.error(
    [
      '',
      `[dev] Port ${port} is already in use${owner ? ` by pid ${owner}` : ''}.`,
      '',
      '      Not starting a second dev server. Next would quietly move to the next free',
      '      port and share this one\'s .next directory, and two Turbopack processes',
      '      writing one build directory corrupt each other — every route then returns a',
      '      500 that looks like an application bug.',
      '',
      `      Use the server already running on http://localhost:${port}, or stop it first:`,
      `          kill ${owner || '<pid>'}`,
      '',
      '      To run a second one deliberately, give it its own build directory:',
      '          NEXT_DIST_DIR=.next-alt PORT=3002 DARB_ALLOW_SECOND_DEV=1 npm run dev',
      '',
    ].join('\n'),
  );
  process.exit(1);
});

probe.once('listening', () => probe.close(() => process.exit(0)));
probe.listen(port, '0.0.0.0');
