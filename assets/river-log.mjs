// The checkpoint we actually applied and the last segment we saw are different cursors.
export class RiverLog {
  constructor(read, onSnapshot, onEvents) {
    this.read = read;
    this.onSnapshot = onSnapshot;
    this.onEvents = onEvents;
    this.epoch = null;
    this.seq = -1;
    this.checkpoint = -1;
  }

  async sync(head) {
    const { epoch, cp, seq } = head;
    // Older servers do not say which segments lost events. Use their checkpoints.
    const snapshotNeeded = epoch !== this.epoch || this.seq > seq ||
      this.checkpoint < (head.repairThrough ?? cp) || this.seq < (head.replayAfter ?? cp);
    try {
      if (snapshotNeeded) {
        const snapshot = await this.read('cp-' + epoch + '-' + cp + '.json');
        if (snapshot.seq !== cp || !Array.isArray(snapshot.items)) throw new Error('Invalid river checkpoint');
        this.onSnapshot(snapshot.items);
        this.epoch = epoch;
        this.seq = this.checkpoint = cp;
      }
      for (let n = this.seq + 1; n <= seq; n++) {
        const segment = await this.read('seg-' + epoch + '-' + n + '.json');
        if (segment.seq !== n || !Array.isArray(segment.ev)) throw new Error('Invalid river segment');
        this.onEvents(segment.ev, snapshotNeeded);
        this.seq = n;
      }
    } catch (err) {
      if (err.status === 404) this.epoch = null;
      throw err;
    }
  }
}
