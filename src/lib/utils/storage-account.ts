import type { KeetaNet } from '../../client/index.js';

type KeetaNetClient = InstanceType<typeof KeetaNet.Client>;
type KeetaNetAccount = InstanceType<typeof KeetaNet.lib.Account>;

/**
 * Resolve the owner of a storage account by querying the network
 * for the ACL entry with the OWNER permission.
 *
 * @param client - A KeetaNet Client (or UserClient) to query the network
 * @param storageAccount - The storage account to resolve the owner for
 * @returns The owner (keyed) account
 */
export async function resolveStorageAccountOwner(client: KeetaNetClient, storageAccount: KeetaNetAccount): Promise<ReturnType<KeetaNetAccount['assertAccount']>> {
	if (!storageAccount.isStorage()) {
		throw(new Error('resolveStorageAccountOwner requires a storage account'));
	}

	const acls = await client.listACLsByEntity(storageAccount);
	for (const acl of acls) {
		if (acl.permissions.has(['OWNER'])) {
			return(acl.principal.assertAccount());
		}
	}

	throw(new Error('Storage account has no owner'));
}
