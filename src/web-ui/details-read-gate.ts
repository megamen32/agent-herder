/** Events may arrive faster than a native history read. Keep that read current
 * until it settles; only explicit reloads or session changes supersede it. */
export class DetailsReadGate {
  private revision = 0;
  private pending?: { key: string; revision: number };

  begin(key: string, explicit: boolean): number | undefined {
    if (!explicit && this.pending?.key === key) return undefined;
    const revision = ++this.revision;
    this.pending = { key, revision };
    return revision;
  }

  isCurrent(revision: number): boolean { return revision === this.revision; }

  finish(revision: number): void {
    if (this.pending?.revision === revision) this.pending = undefined;
  }

  invalidate(): void { ++this.revision; this.pending = undefined; }
}
