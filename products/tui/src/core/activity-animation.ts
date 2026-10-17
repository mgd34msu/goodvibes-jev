/** Keep activity moving when the main model's animation timer is stopped. */
export class ActivityAnimation {
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  frame = 0;

  constructor(private readonly render: () => void) {}

  setActive(active: boolean): void {
    if (this.disposed) return;
    if (!active) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.frame = 0;
    } else if (this.timer === undefined) {
      this.timer = setInterval(() => {
        if (this.timer === undefined || this.disposed) return;
        this.frame++;
        this.render();
      }, 80);
      this.timer.unref();
    }
  }

  dispose(): void {
    this.setActive(false);
    this.disposed = true;
  }
}
