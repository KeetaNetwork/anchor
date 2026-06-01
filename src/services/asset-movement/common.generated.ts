import { createAssert, createAssertEquals, createIs } from "typia";
import type { FiatRails, MovableAssetSearchCanonical, Rail } from './common.js';
import type * as Common from './common.js';

export const isMovableAssetSearchCanonical: (input: unknown) => input is MovableAssetSearchCanonical = createIs<MovableAssetSearchCanonical>();
export const isRail: (input: unknown) => input is Rail = createIs<Rail>();
export const isFiatRail: (input: unknown) => input is FiatRails = createIs<FiatRails>();
export const isAnchorTokenLocationMetadata: (input: unknown) => input is Common.AnchorTokenLocationMetadata = createIs<Common.AnchorTokenLocationMetadata>();

export const assertKeetaSupportedAssetsMetadata: (input: unknown) => Common.SupportedAssetsMetadata[] = createAssert<Common.SupportedAssetsMetadata[]>();
export const assertKeetaSupportedAssetsMetadataItem: (input: unknown) => Common.SupportedAssetsMetadata = createAssert<Common.SupportedAssetsMetadata>();

export const isKeetaAssetMovementAnchorInitiateTransferRequest: (input: unknown) => input is Common.KeetaAssetMovementAnchorInitiateTransferRequest = createIs<Common.KeetaAssetMovementAnchorInitiateTransferRequest>();
export const isKeetaAssetMovementAnchorExecuteTransferRequest: (input: unknown) => input is Common.KeetaAssetMovementAnchorExecuteTransferRequest = createIs<Common.KeetaAssetMovementAnchorExecuteTransferRequest>();
export const isKeetaAssetMovementAnchorExecuteTransferResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorExecuteTransferResponse = createIs<Common.KeetaAssetMovementAnchorExecuteTransferResponse>();
export const isKeetaAssetMovementAnchorGetTransferStatusRequest: (input: unknown) => input is Common.KeetaAssetMovementAnchorGetTransferStatusRequest = createIs<Common.KeetaAssetMovementAnchorGetTransferStatusRequest>();
export const isKeetaAssetMovementAnchorInitiatePersistentForwardingAddressTemplateResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorInitiatePersistentForwardingAddressTemplateResponse = createIs<Common.KeetaAssetMovementAnchorInitiatePersistentForwardingAddressTemplateResponse>();
export const isKeetaAssetMovementAnchorListForwardingAddressTemplateRequest: (input: unknown) => input is Common.KeetaAssetMovementAnchorListForwardingAddressTemplateRequest = createIs<Common.KeetaAssetMovementAnchorListForwardingAddressTemplateRequest>();
export const isKeetaAssetMovementAnchorListForwardingAddressTemplateResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorListForwardingAddressTemplateResponse = createIs<Common.KeetaAssetMovementAnchorListForwardingAddressTemplateResponse>();
export const isKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse = createIs<Common.KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse>();
export const isKeetaAssetMovementAnchorCreatePersistentForwardingResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorCreatePersistentForwardingResponse = createIs<Common.KeetaAssetMovementAnchorCreatePersistentForwardingResponse>();
export const isKeetaAssetMovementAnchorInitiateTransferResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorInitiateTransferResponse = createIs<Common.KeetaAssetMovementAnchorInitiateTransferResponse>();
export const isKeetaAssetMovementAnchorSimulateTransferResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorSimulateTransferResponse = createIs<Common.KeetaAssetMovementAnchorSimulateTransferResponse>();
export const isKeetaAssetMovementAnchorGetExchangeStatusResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorGetTransferStatusResponse = createIs<Common.KeetaAssetMovementAnchorGetTransferStatusResponse>();
export const isKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse = createIs<Common.KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse>();
export const isKeetaAssetMovementAnchorShareKYCResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorShareKYCResponse = createIs<Common.KeetaAssetMovementAnchorShareKYCResponse>();
export const isKeetaAssetMovementAnchorListPersistentForwardingResponse: (input: unknown) => input is Common.KeetaAssetMovementAnchorListPersistentForwardingResponse = createIs<Common.KeetaAssetMovementAnchorListPersistentForwardingResponse>();

export const assertKeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties: (input: unknown) => Common.KeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties = createAssertEquals<Common.KeetaAssetMovementAnchorKYCShareNeededErrorJSONProperties>();
export const assertKeetaAssetMovementAnchorAdditionalKYCNeededErrorJSONProperties: (input: unknown) => Common.KeetaAssetMovementAnchorAdditionalKYCNeededErrorJSONProperties = createAssertEquals<Common.KeetaAssetMovementAnchorAdditionalKYCNeededErrorJSONProperties>();
export const assertKeetaAssetMovementAnchorOperationNotSupportedErrorJSONProperties: (input: unknown) => Common.KeetaAssetMovementAnchorOperationNotSupportedErrorJSONProperties = createAssertEquals<Common.KeetaAssetMovementAnchorOperationNotSupportedErrorJSONProperties>();
export const assertKeetaAssetMovementAnchorUserActionNeededErrorJSONProperties: (input: unknown) => Common.KeetaAssetMovementAnchorUserActionNeededErrorJSONProperties = createAssertEquals<Common.KeetaAssetMovementAnchorUserActionNeededErrorJSONProperties>();

// Back-compat: server-side validators were moved to common.server.generated.ts to keep
// them out of client bundles. Re-exported here (named, so still tree-shakeable) for
// any existing consumer importing them from './common.generated.js'.
export {
	assertKeetaAssetMovementAnchorCreatePersistentForwardingRequest,
	assertKeetaAssetMovementAnchorCreatePersistentForwardingResponse,
	assertKeetaAssetMovementAnchorInitiateTransferRequest,
	assertKeetaAssetMovementAnchorInitiateTransferResponse,
	assertKeetaAssetMovementAnchorSimulateTransferRequest,
	assertKeetaAssetMovementAnchorSimulateTransferResponse,
	assertKeetaAssetMovementAnchorExecuteTransferRequest,
	assertKeetaAssetMovementAnchorExecuteTransferResponse,
	assertKeetaAssetMovementAnchorGetTransferStatusRequest,
	assertKeetaAssetMovementAnchorGetTransferStatusResponse,
	assertKeetaAssetMovementAnchorlistTransactionsRequest,
	assertKeetaAssetMovementAnchorListPersistentForwardingRequest,
	assertKeetaAssetMovementAnchorListPersistentForwardingResponse,
	assertKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse,
	assertKeetaAssetMovementAnchorInitiatePersistentForwardingAddressTemplateRequest,
	assertKeetaAssetMovementAnchorInitiatePersistentForwardingAddressTemplateResponse,
	assertKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest,
	assertKeetaAssetMovementAnchorListForwardingAddressTemplateRequest,
	assertKeetaAssetMovementAnchorListForwardingAddressTemplateResponse,
	assertKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse,
	assertBankAccountAddressObfuscated,
	assertBankAccountAddressResolved,
	assertKeetaAssetMovementAnchorShareKYCRequest,
	assertKeetaAssetMovementAnchorShareKYCResponse
} from './common.server.generated.js';
