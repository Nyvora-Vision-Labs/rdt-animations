# RDT Animations: rdt 1.0 → 3.0

Interactive, in-browser animations of the reliable data transfer protocols from
Kurose & Ross, *Computer Networking: A Top-Down Approach* (§3.4).

**Live:** https://nyvora-vision-labs.github.io/rdt-animations/

| Protocol | Channel | What it adds |
|---|---|---|
| rdt 1.0 | perfect | separate sender/receiver FSMs |
| rdt 2.0 | bit errors | checksum, ACK/NAK, retransmit (and its fatal flaw) |
| rdt 2.1 | bit errors in data and ACK/NAK | 1-bit sequence numbers, duplicate detection |
| rdt 2.2 | same | NAK-free: ACKs carry seq #, a duplicate ACK acts as a NAK |
| rdt 3.0 | bit errors + loss | countdown timer, retransmit on timeout (alternating-bit) |

Each protocol has:

- **Sender and receiver FSMs** that highlight the current state and the transition just taken
- **A timeline (sequence diagram)** with packets in flight, timers, losses and corruption
- **Scripted scenarios**: for example, rdt 2.0's corrupted-ACK fatal flaw, and the four classic rdt 3.0 cases (no loss, packet loss, ACK loss, premature timeout)
- **Interactive timeline**: click any packet to inspect its header (seq #, payload, checksum, timing) and, while it's in flight, corrupt, lose or delay it. Click empty space or drag the time bar to rewind; a change made in the past branches a new history. A faded preview shows what will happen next
- **Free play**: corrupt, lose or delay the next packet from the toolbar
- An event log, the data delivered to the receiving app (duplicates flagged), and a stop-and-wait utilization calculator for rdt 3.0

The simulator runs the real FSM logic of each protocol as a discrete-event simulation. It isn't a canned
animation, so whatever you inject, the protocol responds the way its FSM says it should.

Plain HTML/CSS/JS, no build step. Run locally with `python3 -m http.server` and open `http://localhost:8000`.

Keys: `Space` play/pause · `←`/`→` previous/next event · `Esc` close inspector · `R` restart. Click an event-log entry to jump to it. Deep-link a protocol with `#2.1`, `#3.0`, etc.
