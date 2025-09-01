export class KeetaAnchorUserError extends Error {
	readonly name: string;
	protected statusCode = 400;
	protected keetaAnchorUserErrorObjectTypeID!: string;
	private static readonly keetaAnchorUserErrorObjectTypeID = 'a1e64819-14b6-45ac-a1ec-b9c0bdd51e7b';

	static isInstance(input: unknown): input is KeetaAnchorUserError {
		if (typeof input !== 'object' || input === null) {
			return(false);
		}

		if (!('keetaAnchorUserErrorObjectTypeID' in input)) {
			return(false);
		}

		if (input.keetaAnchorUserErrorObjectTypeID !== KeetaAnchorUserError.keetaAnchorUserErrorObjectTypeID) {
			return(false);
		}

		return(true);
	}

	constructor(message: string) {
		super(message);
		this.name = 'KeetaAnchorUserError';

		Object.defineProperty(this, 'keetaAnchorUserErrorObjectTypeID', {
			value: KeetaAnchorUserError.keetaAnchorUserErrorObjectTypeID,
			enumerable: false
		});
	}

	asErrorResponse(contentType: 'text/plain' | 'application/json'): { error: string; statusCode: number; contentType: string } {
		let message = this.message;
		if (contentType === 'application/json') {
			message = JSON.stringify({ ok: false, error: this.message });
		}

		return({
			error: message,
			statusCode: this.statusCode,
			contentType: contentType
		});
	}
}
