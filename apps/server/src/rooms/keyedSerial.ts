/** Runs the async work of one key (userId) strictly in arrival order. */
export class KeyedSerial {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const p = (this.chains.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = p
      .catch(() => undefined)
      .then(() => {
        if (this.chains.get(key) === tail) this.chains.delete(key);
      });
    this.chains.set(key, tail);
    return p;
  }
}
