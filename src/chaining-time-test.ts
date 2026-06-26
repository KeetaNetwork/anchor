import { KeetaNet } from "./client/index.js";
import { AnchorChaining } from "./lib/chaining.js";
import { Resolver } from "./lib/index.js";

const counters: Record<string, number> = {};
function instrumentAccount() {
    const A: any = KeetaNet.lib.Account;
    const wrap = (obj: any, name: string, label: string) => {
        const orig = obj[name];
        if (typeof orig !== 'function') { return; }
        obj[name] = function(...args: any[]) {
            counters[label] = (counters[label] ?? 0) + 1;
            return orig.apply(this, args);
        };
    };
    wrap(A, 'fromPublicKeyString', 'Account.fromPublicKeyString');
    wrap(A, 'toAccount', 'Account.toAccount');
    const proto = A.prototype;
    wrap(proto, 'comparePublicKey', 'account.comparePublicKey');
    wrap(proto, 'assertKeyType', 'account.assertKeyType');
    wrap(proto, 'isToken', 'account.isToken');
}
function dumpCounters(label: string) {
    console.log(`--- account op counts (${label}) ---`);
    for (const [k, v] of Object.entries(counters).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k}: ${v}`);
    }
    for (const k of Object.keys(counters)) { counters[k] = 0; }
}

async function main() {
    instrumentAccount();
    const client = KeetaNet.UserClient.fromNetwork('main', KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));

    const resolver = new Resolver({
        client,
        root: [ client.networkAddress, KeetaNet.lib.Account.fromPublicKeyString('keeta_aabvyweig7ve73pwlb4mptseoymmbnlmu47oayknbs3m3tvtbkdmf72lfxtt4ua') ],
        trustedCAs: [],
        metadataConfig: { allowInsecureProtocols: true }
    });

    const chaining = new AnchorChaining({
        resolver,
        client
    });

    const start = Date.now();
    console.log('Resolving assets...');
    await chaining.graph.resolveAssets({ to: { location: `chain:keeta:${client.network}` } });
    console.log(`Resolved assets in ${Date.now() - start}ms`);
    dumpCounters('cold: build graph + resolveAssets');

    console.log('Resolving again after cache (same graph, memoized nodes)');
    const start2 = Date.now();
    await chaining.graph.resolveAssets();
    console.log(`Resolved assets in ${Date.now() - start2}ms`);
    dumpCounters('memoized nodes: resolveAssets only');

    console.log('Resolving on a FRESH graph sharing the same resolver (warm HTTP cache, cold node parse)');
    const chaining2 = new AnchorChaining({ resolver, client });
    const start3 = Date.now();
    await chaining2.graph.resolveAssets();
    console.log(`Resolved assets in ${Date.now() - start3}ms`);
    dumpCounters('fresh graph warm http: parse + resolveAssets');
}

main().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
