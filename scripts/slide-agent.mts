import { runAgentCli } from '../src/cli/agentCli.js';

/**
 * `slide-agent` entry point:
 *   npm run agent -- <command> [options]
 *
 * Everything the command prints on stdout is JSON; diagnostics go to stderr,
 * so a caller can pipe stdout straight into a parser.
 */
const code = await runAgentCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  cwd: process.cwd(),
});
process.exit(code);
