/** The thread's backend adapter cannot accept a send right now. REST maps this to
 *  503 backend_unavailable; the message is NOT persisted (the client keeps it queued). */
export class BackendUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailable";
  }
}
