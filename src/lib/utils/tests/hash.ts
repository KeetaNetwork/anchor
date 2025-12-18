import * as crypto from 'crypto';

export function hash(input: string, length: number = Infinity): string {
	const hasher = crypto.createHash('sha256').update(input);

	return(hasher.digest('hex').slice(0, length));
}
