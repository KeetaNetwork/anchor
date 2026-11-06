/**
 * Entry point for the `keeta-contract` CLI (see ./cli.ts).
 */
import { runContractsCli } from './cli.js';

(async function() {
	process.exit(await runContractsCli(process.argv.slice(2)));
})().catch(function(err: unknown) {
	console.error(err);
	process.exit(1);
});
