import type { Logger } from '../log/index.js';

interface DisposableTimingHandle extends Disposable {
	id: symbol;
	end: () => void;
	[Symbol.dispose]: () => void;
}

type TimingSection = {
	id: string;
	name: string;
	start: number;
	end?: number;
};

export class RequestTiming {
	log: Logger | undefined;
	readonly #timing = new Map<symbol, TimingSection>();
	#counter = 0;

	startTime(section: string): DisposableTimingHandle {
		const id = Symbol(section);
		this.#timing.set(id, {
			id: section,
			name: section,
			start: Date.now()
		});

		let endCalled = false;

		return({
			id: id,
			end: () => {
				endCalled = true;
				this.endTime(id);
			},
			[Symbol.dispose]: () => {
				if (endCalled) {
					return;
				}

				this.endTime(id);
			}
		});
	}

	endTime(section: symbol | undefined | DisposableTimingHandle): void {
		if (section === undefined) {
			return;
		}

		let id: symbol;
		if (typeof section === 'symbol') {
			id = section;
		} else {
			id = section.id;
		}

		const timingInfo = this.#timing.get(id);
		if (timingInfo === undefined) {
			this.log?.error('timing::endTime', `Timing section ${String(id)} does not exist but "end" was called on it!`);
			return;
		}

		if (timingInfo.end !== undefined) {
			this.log?.error('timing::endTime', `Timing section ${timingInfo.id} already ended but "end" was called on it again!`);
			return;
		}

		timingInfo.end = Date.now();
		timingInfo.id = `${timingInfo.id}-${this.counter()}`;
	}

	static async runTimer<T>(section: string, timing: RequestTiming | undefined, code: () => Promise<T>): Promise<T> {
		if (timing === undefined) {
			return(await code());
		}

		return(await timing.runTimer(section, code));
	}

	async runTimer<T>(section: string, code: () => Promise<T>): Promise<T> {
		const handle = this.startTime(section);
		try {
			return(await code());
		} finally {
			this.endTime(handle);
		}
	}

	getAllTiming(): { [section: string]: { name: string; duration: number; }; } {
		const retval: { [section: string]: { name: string; duration: number; }; } = {};

		for (const timingInfo of this.#timing.values()) {
			if (timingInfo.end === undefined) {
				continue;
			}

			retval[timingInfo.id] = {
				name: timingInfo.name,
				duration: timingInfo.end - timingInfo.start
			};
		}

		return(retval);
	}

	counter(): number {
		const retval = this.#counter;
		this.#counter++;

		return(retval);
	}
}
