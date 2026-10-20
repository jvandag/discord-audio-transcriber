/** Membership, not silence, drives auto-stop. The callback rechecks current membership. */
export class EmptyChannelTimer {
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private isEmpty: () => boolean,
    private stop: () => void,
    private delay = 30_000,
  ) {}
  update() {
    if (!this.isEmpty()) {
      this.clear();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      if (this.isEmpty()) this.stop();
    }, this.delay);
  }
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
