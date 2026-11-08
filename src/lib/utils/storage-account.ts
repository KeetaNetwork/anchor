import type * as KeetaNet from '@keetanetwork/keetanet-client';
import type Account from '@keetanetwork/keetanet-client/lib/account.js';
import type { HTTPSignedField } from '../http-server/common.js';
import type { Signable } from './signing.js';
import { VerifySignedData } from './signing.js';

type KeetaNetClient = InstanceType<typeof KeetaNet.Client>;
type KeetaNetAccount = InstanceType<typeof KeetaNet.lib.Account>;

/**
 * The accounts that may act for a storage account: its owner, and every
 * keyed account the owner granted SEND_ON_BEHALF (for example an agent).
 */
export type StorageAccountAuthority = {
	owner: Account.Account;
	delegates: Account.Account[];
};

/**
 * Whether an ACL row applies to the whole storage account rather than to
 * one target within it.  The network treats an unset target, or a target
 * equal to the entity itself, as the whole account.
 */
export function isWholeAccountGrant(target: Pick<KeetaNetAccount, 'comparePublicKey'> | undefined | null, storageAccount: KeetaNetAccount): boolean {
	if (target === undefined || target === null) {
		return(true);
	}

	return(target.comparePublicKey(storageAccount));
}

/**
 * Resolve who may act for a storage account by reading its ACLs: the
 * OWNER, plus each keyed account holding SEND_ON_BEHALF on the whole
 * account (not scoped to a target).
 *
 * Grants whose principal is not a keyed account (for example a
 * certificate principal) are not delegates here, because a request
 * signature can only be checked against a key.
 *
 * @param client - A KeetaNet Client to query the network
 * @param storageAccount - The storage account to resolve
 */
export async function resolveStorageAccountAuthority(client: KeetaNetClient, storageAccount: KeetaNetAccount): Promise<StorageAccountAuthority> {
	if (!storageAccount.isStorage()) {
		throw(new Error('resolveStorageAccountAuthority requires a storage account'));
	}

	const acls = await client.listACLsByEntity(storageAccount);

	let owner: Account.Account | null = null;
	const delegates: Account.Account[] = [];
	for (const acl of acls) {
		if (acl.principalType !== 'ACCOUNT') {
			continue;
		}

		if (acl.permissions.has(['OWNER'])) {
			if (owner !== null) {
				throw(new Error('Storage account has more than one owner'));
			}

			owner = acl.principal.assertAccount();
			continue;
		}

		if (!acl.principal.isAccount()) {
			continue;
		}

		/*
		 * Only a grant on the whole storage account makes a delegate.  A
		 * grant scoped to a target (for example one token) lets the
		 * principal send only that, so it must not let it sign anchor
		 * requests for the account as a whole.
		 */
		if (!isWholeAccountGrant(acl.target, storageAccount)) {
			continue;
		}

		if (acl.permissions.has(['SEND_ON_BEHALF'])) {
			const principal = acl.principal.assertAccount();
			if (!delegates.some(function(existing) { return(existing.comparePublicKey(principal)); })) {
				delegates.push(principal);
			}
		}
	}

	if (owner === null) {
		throw(new Error('Storage account has no owner'));
	}

	return({ owner, delegates });
}

/**
 * Resolve the owner of a storage account by querying the network
 * for the ACL entry with the OWNER permission.
 *
 * @param client - A KeetaNet Client (or UserClient) to query the network
 * @param storageAccount - The storage account to resolve the owner for
 * @returns The owner (keyed) account
 */
export async function resolveStorageAccountOwner(client: KeetaNetClient, storageAccount: KeetaNetAccount): Promise<Account.Account> {
	const { owner } = await resolveStorageAccountAuthority(client, storageAccount);
	return(owner);
}

/**
 * Check a request signed for a storage account.  The signature may come
 * from the owner or from any delegate holding SEND_ON_BEHALF.
 *
 * The caller should prefix `signable` with the storage account, as the
 * clients do, so a signature for one storage account cannot be replayed
 * against another the same key can act for.
 *
 * @returns The owner (whose identity and KYC the request carries) and the
 *          account that actually signed, or null when nobody allowed to act
 *          for the storage account produced the signature
 */
export async function verifyStorageAccountSignature(client: KeetaNetClient, storageAccount: KeetaNetAccount, signable: Signable, signed: HTTPSignedField): Promise<{ owner: Account.Account; signer: Account.Account; } | null> {
	const { owner, delegates } = await resolveStorageAccountAuthority(client, storageAccount);

	for (const candidate of [ owner, ...delegates ]) {
		if (await VerifySignedData(candidate, signable, signed)) {
			return({ owner, signer: candidate });
		}
	}

	return(null);
}
