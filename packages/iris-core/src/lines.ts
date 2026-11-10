/**
 * 一行一行的输入队列（ADR-0033）。
 *
 * 为什么自己写：Node 24 的 rl.question() 在管道输入下第二次不会 resolve；
 * 而只用一个 wake 回调的话，两处同时等着要输入时后来的会把前一个顶掉——
 * 谁也醒不过来，进程最后以 "Detected unsettled top-level await" 收场（真踩过）。
 * 这里等的人排队，按先来后到唤醒。
 */
export class LineQueue {
	private readonly pending: string[] = [];
	private readonly waiting: ((line: string | null) => void)[] = [];
	private done = false;

	/** 还有几行没被取走。 */
	get buffered(): number {
		return this.pending.length;
	}

	/** 输入源关了以后再取只会拿到 null（缓冲里的行仍然先发完）。 */
	get closed(): boolean {
		return this.done;
	}

	/** 来了一行：有人在等就直接给他，没人等就存着。 */
	push(line: string): void {
		const waiter = this.waiting.shift();
		if (waiter === undefined) this.pending.push(line);
		else waiter(line);
	}

	/** 输入源关了：把所有还在等的人一起放掉，返回 null。 */
	close(): void {
		this.done = true;
		while (this.waiting.length > 0) this.waiting.shift()?.(null);
	}

	/** 拿下一行：有存货立刻给，没人给就排队等。 */
	next(): Promise<string | null> {
		const ready = this.pending.shift();
		if (ready !== undefined) return Promise.resolve(ready);
		if (this.done) return Promise.resolve(null);
		return new Promise((resolve) => this.waiting.push(resolve));
	}
}
