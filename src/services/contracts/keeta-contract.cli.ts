/**
 * Entry point for the `keeta-contract` CLI (see ./cli.ts).
 */
// The package's client index first: the contracts client is reached through it (config and the resolver lead back to it), as when the
// library is used, so its modules load in an order without a cycle.
import '../../client/index.js';
import { runContractsCli } from './cli.js';

(async function() {
	process.exit(await runContractsCli(process.argv.slice(2)));
})().catch(function(err: unknown) {
	console.error(err);
	process.exit(1);
});
