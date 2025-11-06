import Resolver from './lib/resolver.js';
import type {
	Client as KeetaNetClient,
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import KeetaNet from '@keetanetwork/keetanet-client';

type KeetaNetNetworks = typeof KeetaNet.Client.Config.networksArray[number];
type ResolverOptions = Partial<Omit<ConstructorParameters<typeof Resolver>[0], 'client'>> & {
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	network?: bigint | KeetaNetNetworks | string | undefined;
};
type ResolverConfig = ConstructorParameters<typeof Resolver>[0];

export function getDefaultResolverConfig(client: KeetaNetClient | KeetaNetUserClient, options: ResolverOptions = {}): ResolverConfig {
	/**
	 * The default Root account for the resolver is the network account, so
	 * we need to look it up from what the user provided.
	 */
	if (options.network === undefined) {
		if ('network' in client && client.network !== undefined) {
			options.network = client.network;
		}
	}

	if (options.network === undefined) {
		throw(new Error('Network must be specified in options or a UserClient must be provided with a network'));
	}

	let networkID: bigint;
	if (typeof options.network === 'string') {
		if (!KeetaNet.Client.Config.isNetwork(options.network)) {
			throw(new Error(`Invalid network: ${options.network}`));
		}
		const networkAlias = KeetaNet.Client.Config.getNetworkAlias(options.network);
		const defaultConfig = KeetaNet.Client.Config.getDefaultConfig(networkAlias);
		networkID = defaultConfig.network;
	} else {
		networkID = options.network;
	}
	const networkAccount = KeetaNet.lib.Account.generateNetworkAddress(networkID);

	return({
		client: client,
		root: networkAccount,
		trustedCAs: [],
		...options
	});
}

export function getDefaultResolver(client: KeetaNetClient | KeetaNetUserClient, options: ResolverOptions = {}): Resolver {
	const resolverConfig = getDefaultResolverConfig(client, options);

	return(new Resolver(resolverConfig));
}
