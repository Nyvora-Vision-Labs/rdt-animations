'use strict';
/* =====================================================================
   RDT animations: a small discrete-event simulator that runs the real
   sender/receiver FSM logic of rdt 1.0, 2.0, 2.1, 2.2 and 3.0, plus an
   SVG renderer (timeline + FSMs).
   ===================================================================== */

const D = 10;          // one-way propagation delay (time units)
const GAP = 2;         // app hands the next chunk this long after the sender is ready
const LONG_DELAY = 25; // one-way delay of a "delayed" packet
const PX = 7;          // pixels per time unit on the timeline
const Y0 = 34;
const XS = 190, XR = 450; // lifelines

/* ---------------- protocol definitions ---------------- */

const ack = s => 'ACK' + (s === undefined ? '' : s);

// helper: a four-state alternating-bit sender (rdt 2.1 / 2.2 / 3.0)
function fourSender(waitName, edges) {
  return {
    sStates: [
      ['call0', 'Wait for\ncall 0\nfrom above'],
      ['ack0', waitName(0)],
      ['call1', 'Wait for\ncall 1\nfrom above'],
      ['ack1', waitName(1)],
    ],
    sEdges: edges,
  };
}
const twoReceiver = edges => ({
  rStates: [['w0', 'Wait for\n0 from\nbelow'], ['w1', 'Wait for\n1 from\nbelow']],
  rEdges: edges,
});

const P = {};

P['1.0'] = {
  name: 'rdt 1.0',
  title: 'rdt 1.0 — reliable transfer over a reliable channel',
  sub: 'The underlying channel is perfect, so the protocol has nothing to fix.',
  info: [
    ['Channel assumptions', ['No bit errors', 'No packet loss']],
    ['Mechanisms', ['Separate FSMs for sender and receiver', 'Sender: make_pkt + udt_send', 'Receiver: extract + deliver_data']],
    ['Why it is not enough', ['Real channels flip bits and drop packets, and rdt 1.0 has no feedback at all']],
  ],
  fates: [],
  sStates: [['call', 'Wait for\ncall from\nabove']],
  rStates: [['r', 'Wait for\ncall from\nbelow']],
  sEdges: [{ from: 'call', to: 'call', lines: ['rdt_send(data)', 'make_pkt; udt_send'] }],
  rEdges: [{ from: 'r', to: 'r', lines: ['rdt_rcv(pkt)', 'extract; deliver_data'] }],
  scenarios: [
    { id: 'normal', name: 'Normal operation', count: 4, desc: 'The app hands down data, the sender wraps it in a packet and sends it. The receiver unwraps it and delivers it. There are no ACKs because nothing can go wrong.' },
  ],
  init(sim) { sim.S.state = 'call'; sim.R.state = 'r'; },
  onApp(sim, d) {
    sim.trans('S', 'call', `rdt_send(${d})`, `packet = make_pkt(${d}); udt_send(packet)`, `send ${d}`);
    sim.send('S', { type: 'data', data: d });
    sim.scheduleApp(8);
  },
  onRecvR(sim, p) {
    sim.trans('R', 'r', 'rdt_rcv(packet)', `extract(packet, ${p.data}); deliver_data(${p.data})`, `deliver ${p.data}`, 'good');
    sim.deliver(p.data);
  },
  onRecvS() {}, onTimeout() {},
};

P['2.0'] = {
  name: 'rdt 2.0',
  title: 'rdt 2.0 — a channel with bit errors',
  sub: 'Stop-and-wait with error detection and ACK/NAK feedback.',
  info: [
    ['Channel assumptions', ['Bits in a packet may be flipped', 'No packet loss']],
    ['New mechanisms', ['Error detection (checksum)', 'Receiver feedback: ACK = OK, NAK = had errors', 'Retransmit the packet on NAK', 'Stop-and-wait: one packet in flight']],
    ['Fatal flaw', ['If the ACK/NAK itself is corrupted, the sender does not know what happened at the receiver', 'Retransmitting can deliver a duplicate, and the receiver cannot tell (no sequence numbers)']],
  ],
  fates: ['corrupt'],
  sStates: [['call', 'Wait for\ncall from\nabove'], ['wait', 'Wait for\nACK or\nNAK']],
  rStates: [['r', 'Wait for\ncall from\nbelow']],
  sEdges: [
    { from: 'call', to: 'wait', lines: ['rdt_send(data)', 'send sndpkt'] },
    { from: 'wait', to: 'wait', lines: ['rcv NAK', 'udt_send(sndpkt)'] },
    { from: 'wait', to: 'call', lines: ['rcv ACK', 'Λ'] },
  ],
  rEdges: [{ from: 'r', to: 'r', lines: ['corrupt: send NAK', 'ok: deliver; send ACK'] }],
  scenarios: [
    { id: 'ok', name: 'No errors', count: 3, desc: 'Every packet arrives intact. Each one is ACKed before the sender takes the next chunk from the app (stop-and-wait).' },
    { id: 'pkt', name: 'Corrupted packet → NAK', count: 3, fates: { S2: 'corrupt' }, desc: 'Bit errors hit the second packet. The receiver\'s checksum catches them and it replies NAK, so the sender retransmits.' },
    { id: 'flaw', name: 'Fatal flaw: corrupted ACK', count: 3, fates: { R1: 'corrupt' }, desc: 'D1 arrives fine but its ACK is garbled. The sender can\'t tell ACK from NAK, so it retransmits. The receiver has no sequence numbers and delivers D1 a second time.' },
    { id: 'free', name: 'Free play', count: 6, desc: 'No scripted errors. Use the buttons above, or click packets in flight, to corrupt them.' },
  ],
  init(sim) { sim.S.state = 'call'; sim.R.state = 'r'; },
  onApp(sim, d) {
    sim.trans('S', 'wait', `rdt_send(${d})`, `sndpkt = make_pkt(${d}, checksum); udt_send(sndpkt)`, `send ${d}`);
    sim.S.cur = { type: 'data', data: d };
    sim.send('S', sim.S.cur);
  },
  onRecvS(sim, p) {
    if (p.corrupt) {
      sim.trans('S', 'wait', 'rdt_rcv(rcvpkt) && corrupt(rcvpkt)', '?? garbled: ACK or NAK? rdt 2.0 has no answer. Retransmitting risks a duplicate', 'garbled ACK/NAK!', 'bad');
      sim.send('S', sim.S.cur, true);
    } else if (p.type === 'NAK') {
      sim.trans('S', 'wait', 'rdt_rcv(rcvpkt) && isNAK(rcvpkt)', 'udt_send(sndpkt): retransmit', 'NAK → resend', 'warn');
      sim.send('S', sim.S.cur, true);
    } else {
      sim.trans('S', 'call', 'rdt_rcv(rcvpkt) && isACK(rcvpkt)', 'Λ (ready for the next chunk)', 'ACK ✓', 'good');
      sim.scheduleApp();
    }
  },
  onRecvR(sim, p) {
    if (p.corrupt) {
      sim.trans('R', 'r', 'rdt_rcv(rcvpkt) && corrupt(rcvpkt)', 'udt_send(NAK)', 'corrupt → NAK', 'warn');
      sim.send('R', { type: 'NAK' });
    } else {
      const dup = sim.isDelivered(p.data);
      sim.trans('R', 'r', 'rdt_rcv(rcvpkt) && notcorrupt(rcvpkt)', `extract; deliver_data(${p.data}); udt_send(ACK)` + (dup ? '  ⚠ DUPLICATE delivered!' : ''), dup ? `deliver ${p.data} AGAIN ⚠` : `deliver ${p.data}`, dup ? 'bad' : 'good');
      sim.deliver(p.data);
      sim.send('R', { type: 'ACK' });
    }
  },
  onTimeout() {},
};

P['2.1'] = {
  name: 'rdt 2.1',
  title: 'rdt 2.1 — handling garbled ACK/NAKs',
  sub: 'Add a 1-bit sequence number so the receiver can spot duplicates.',
  info: [
    ['Channel assumptions', ['Bit errors in data and in ACK/NAK packets', 'No packet loss']],
    ['New mechanisms', ['Sequence number (0/1) in every data packet', 'Sender retransmits if the ACK/NAK is garbled', 'Receiver discards duplicates but still ACKs them', 'Twice as many states: each must "remember" the expected seq #']],
    ['Remaining limits', ['Receiver can\'t know if its last ACK/NAK arrived OK', 'Still needs NAKs, and can\'t cope with loss']],
  ],
  fates: ['corrupt'],
  ...fourSender(s => `Wait for\nACK or\nNAK ${s}`, [
    { from: 'call0', to: 'ack0', lines: ['rdt_send(data)', 'send pkt0'] },
    { from: 'ack0', to: 'ack0', lines: ['corrupt ∨ NAK', 'resend pkt0'] },
    { from: 'ack0', to: 'call1', lines: ['ACK, not corrupt', 'Λ'] },
    { from: 'call1', to: 'ack1', lines: ['rdt_send(data)', 'send pkt1'] },
    { from: 'ack1', to: 'ack1', lines: ['corrupt ∨ NAK', 'resend pkt1'] },
    { from: 'ack1', to: 'call0', lines: ['ACK, not corrupt', 'Λ'] },
  ]),
  ...twoReceiver([
    { from: 'w0', to: 'w1', lines: ['pkt0 ok', 'deliver; ACK'] },
    { from: 'w0', to: 'w0', lines: ['corrupt: NAK', 'pkt1 (dup): ACK'] },
    { from: 'w1', to: 'w0', lines: ['pkt1 ok', 'deliver; ACK'] },
    { from: 'w1', to: 'w1', lines: ['corrupt: NAK', 'pkt0 (dup): ACK'] },
  ]),
  scenarios: [
    { id: 'ok', name: 'No errors', count: 3, desc: 'Sequence numbers alternate 0, 1, 0, … and both sides move around their FSMs.' },
    { id: 'pkt', name: 'Corrupted packet', count: 3, fates: { S1: 'corrupt' }, desc: 'pkt0 is corrupted. The receiver stays in "Wait for 0" and sends NAK. The sender resends pkt0.' },
    { id: 'ack', name: 'Corrupted ACK → duplicate', count: 3, fates: { R1: 'corrupt' }, desc: 'pkt0 is delivered but the ACK is garbled. The sender resends pkt0. The receiver is now waiting for 1, so it recognises pkt0 as a duplicate, discards it and re-ACKs. The fatal flaw of rdt 2.0 is fixed.' },
    { id: 'nak', name: 'Corrupted NAK', count: 3, fates: { S1: 'corrupt', R1: 'corrupt' }, desc: 'pkt0 is corrupted and so is the NAK. The sender treats a garbled reply like a NAK and resends. The receiver is still waiting for 0, so it accepts the copy.' },
    { id: 'free', name: 'Free play', count: 6, desc: 'Inject corruption into data or ACK/NAKs yourself.' },
  ],
  init(sim) { sim.S.state = 'call0'; sim.S.seq = 0; sim.R.state = 'w0'; sim.R.exp = 0; },
  onApp(sim, d) {
    const s = sim.S.seq;
    sim.trans('S', 'ack' + s, `rdt_send(${d})`, `sndpkt = make_pkt(${s}, ${d}, checksum); udt_send(sndpkt)`, `send pkt${s}`);
    sim.S.cur = { type: 'data', seq: s, data: d };
    sim.send('S', sim.S.cur);
  },
  onRecvS(sim, p) {
    const s = sim.S.seq;
    if (p.corrupt || p.type === 'NAK') {
      sim.trans('S', 'ack' + s, `rdt_rcv(rcvpkt) && (corrupt(rcvpkt) || isNAK(rcvpkt))`, `udt_send(sndpkt): retransmit pkt${s}`, p.corrupt ? 'garbled → resend' : 'NAK → resend', 'warn');
      sim.send('S', sim.S.cur, true);
    } else {
      sim.trans('S', 'call' + (1 - s), 'rdt_rcv(rcvpkt) && notcorrupt(rcvpkt) && isACK(rcvpkt)', 'Λ', 'ACK ✓', 'good');
      sim.S.seq = 1 - s;
      sim.scheduleApp();
    }
  },
  onRecvR(sim, p) {
    const e = sim.R.exp;
    if (p.corrupt) {
      sim.trans('R', 'w' + e, 'rdt_rcv(rcvpkt) && corrupt(rcvpkt)', 'sndpkt = make_pkt(NAK, chksum); udt_send(sndpkt)', 'corrupt → NAK', 'warn');
      sim.send('R', { type: 'NAK' });
    } else if (p.seq === e) {
      sim.trans('R', 'w' + (1 - e), `rdt_rcv(rcvpkt) && notcorrupt(rcvpkt) && has_seq${e}(rcvpkt)`, `extract; deliver_data(${p.data}); udt_send(ACK)`, `deliver ${p.data}`, 'good');
      sim.R.exp = 1 - e;
      sim.deliver(p.data);
      sim.send('R', { type: 'ACK' });
    } else {
      sim.trans('R', 'w' + e, `rdt_rcv(rcvpkt) && notcorrupt(rcvpkt) && has_seq${p.seq}(rcvpkt)`, `duplicate pkt${p.seq}: discard, udt_send(ACK)`, `dup pkt${p.seq} → discard, ACK`, 'warn');
      sim.send('R', { type: 'ACK' });
    }
  },
  onTimeout() {},
};

// receiver shared by rdt 2.2 and rdt 3.0
function nakFreeReceiver(sim, p) {
  const e = sim.R.exp;
  if (p.corrupt || p.seq !== e) {
    const why = p.corrupt ? 'corrupt(rcvpkt)' : `has_seq${p.seq}(rcvpkt)`;
    sim.trans('R', 'w' + e, `rdt_rcv(rcvpkt) && (${why})`, `udt_send(sndpkt): re-send ACK${1 - e} (ACK for last good pkt)`,
      p.corrupt ? `corrupt → ACK${1 - e}` : `dup pkt${p.seq} → discard, ACK${1 - e}`, 'warn');
    sim.send('R', { type: 'ACK', seq: 1 - e });
  } else {
    sim.trans('R', 'w' + (1 - e), `rdt_rcv(rcvpkt) && notcorrupt(rcvpkt) && has_seq${e}(rcvpkt)`, `extract; deliver_data(${p.data}); sndpkt = make_pkt(ACK${e}, chksum); udt_send(sndpkt)`, `deliver ${p.data}`, 'good');
    sim.R.exp = 1 - e;
    sim.deliver(p.data);
    sim.send('R', { type: 'ACK', seq: e });
  }
}
const nakFreeREdges = twoReceiver([
  { from: 'w0', to: 'w1', lines: ['pkt0 ok', 'deliver; ACK0'] },
  { from: 'w0', to: 'w0', lines: ['corrupt ∨ pkt1', 'send ACK1'] },
  { from: 'w1', to: 'w0', lines: ['pkt1 ok', 'deliver; ACK1'] },
  { from: 'w1', to: 'w1', lines: ['corrupt ∨ pkt0', 'send ACK0'] },
]);

P['2.2'] = {
  name: 'rdt 2.2',
  title: 'rdt 2.2 — a NAK-free protocol',
  sub: 'Same behaviour as rdt 2.1, but only ACKs, each carrying a sequence number.',
  info: [
    ['Channel assumptions', ['Bit errors in data and ACK packets', 'No packet loss']],
    ['New mechanisms', ['No NAKs: the receiver ACKs the last packet received OK', 'The ACK carries the seq # being ACKed', 'Duplicate ACK at the sender means the same as a NAK: retransmit the current packet']],
    ['Why it matters', ['This is the step towards TCP, which also uses only (cumulative) ACKs', 'Still can\'t cope with lost packets']],
  ],
  fates: ['corrupt'],
  ...fourSender(s => `Wait for\nACK${s}`, [
    { from: 'call0', to: 'ack0', lines: ['rdt_send(data)', 'send pkt0'] },
    { from: 'ack0', to: 'ack0', lines: ['corrupt ∨ ACK1', 'resend pkt0'] },
    { from: 'ack0', to: 'call1', lines: ['ACK0 ok', 'Λ'] },
    { from: 'call1', to: 'ack1', lines: ['rdt_send(data)', 'send pkt1'] },
    { from: 'ack1', to: 'ack1', lines: ['corrupt ∨ ACK0', 'resend pkt1'] },
    { from: 'ack1', to: 'call0', lines: ['ACK1 ok', 'Λ'] },
  ]),
  ...nakFreeREdges,
  scenarios: [
    { id: 'ok', name: 'No errors', count: 3, desc: 'Each ACK names the packet it acknowledges: pkt0 → ACK0, pkt1 → ACK1.' },
    { id: 'pkt', name: 'Corrupted pkt → duplicate ACK', count: 3, fates: { S2: 'corrupt' }, desc: 'pkt1 is corrupted. Instead of a NAK the receiver re-sends ACK0, the ACK for the last good packet. The sender is waiting for ACK1, so ACK0 is a duplicate and it retransmits pkt1.' },
    { id: 'ack', name: 'Corrupted ACK', count: 3, fates: { R1: 'corrupt' }, desc: 'ACK0 is garbled, so the sender resends pkt0. The receiver (waiting for 1) discards the duplicate and re-sends ACK0.' },
    { id: 'free', name: 'Free play', count: 6, desc: 'Inject corruption into data or ACKs yourself.' },
  ],
  init(sim) { sim.S.state = 'call0'; sim.S.seq = 0; sim.R.state = 'w0'; sim.R.exp = 0; },
  onApp: P['2.1'].onApp,
  onRecvS(sim, p) {
    const s = sim.S.seq;
    if (p.corrupt || p.seq !== s) {
      sim.trans('S', 'ack' + s, `rdt_rcv(rcvpkt) && (corrupt(rcvpkt) || isACK(rcvpkt, ${1 - s}))`, `udt_send(sndpkt): retransmit pkt${s}`, p.corrupt ? 'garbled → resend' : `dup ACK${p.seq} → resend`, 'warn');
      sim.send('S', sim.S.cur, true);
    } else {
      sim.trans('S', 'call' + (1 - s), `rdt_rcv(rcvpkt) && notcorrupt(rcvpkt) && isACK(rcvpkt, ${s})`, 'Λ', `ACK${s} ✓`, 'good');
      sim.S.seq = 1 - s;
      sim.scheduleApp();
    }
  },
  onRecvR: nakFreeReceiver,
  onTimeout() {},
};

P['3.0'] = {
  name: 'rdt 3.0',
  title: 'rdt 3.0 — a channel with errors and loss',
  sub: 'The alternating-bit protocol: rdt 2.2 plus a countdown timer.',
  info: [
    ['Channel assumptions', ['Bit errors in data and ACKs', 'Packets (data or ACKs) can be lost', 'Packets may be delayed but are not reordered']],
    ['New mechanisms', ['Countdown timer: start on send, stop on the correct ACK', 'Timeout → retransmit and restart the timer', 'Wrong or garbled ACK → do nothing (Λ), let the timer handle it', 'Seq #s absorb the duplicates a premature timeout creates']],
    ['Performance', ['Stop-and-wait: U_sender = (L/R) / (RTT + L/R)', 'Correct but slow, which motivates pipelining (GBN / SR)']],
  ],
  fates: ['corrupt', 'lost', 'delay'],
  ...fourSender(s => `Wait for\nACK${s}`, [
    { from: 'call0', to: 'call0', lines: ['rdt_rcv: Λ'] },
    { from: 'call0', to: 'ack0', lines: ['rdt_send(data)', 'send pkt0; start_timer'] },
    { from: 'ack0', to: 'ack0', lines: ['timeout: resend, start_timer', 'corrupt ∨ ACK1: Λ'] },
    { from: 'ack0', to: 'call1', lines: ['ACK0 ok', 'stop_timer'] },
    { from: 'call1', to: 'call1', lines: ['rdt_rcv: Λ'] },
    { from: 'call1', to: 'ack1', lines: ['rdt_send(data)', 'send pkt1; start_timer'] },
    { from: 'ack1', to: 'ack1', lines: ['timeout: resend, start_timer', 'corrupt ∨ ACK0: Λ'] },
    { from: 'ack1', to: 'call0', lines: ['ACK1 ok', 'stop_timer'] },
  ]),
  ...nakFreeREdges,
  scenarios: [
    { id: 'ok', name: '(a) No loss', count: 3, desc: 'Each packet starts the timer. The correct ACK comes back before the timeout and stops it.' },
    { id: 'pktloss', name: '(b) Packet loss', count: 3, fates: { S2: 'lost' }, desc: 'pkt1 is lost. No ACK ever comes, the timer expires, and the sender retransmits pkt1.' },
    { id: 'ackloss', name: '(c) ACK loss', count: 3, fates: { R2: 'lost' }, desc: 'pkt1 is delivered but ACK1 is lost. On timeout the sender resends pkt1. The receiver (now waiting for 0) sees a duplicate, discards it and re-sends ACK1.' },
    { id: 'premature', name: '(d) Premature timeout', count: 3, fates: { R2: 'delay' }, desc: 'ACK1 is only delayed, but the timer fires first and pkt1 is resent anyway. The late ACK1 still advances the sender. The receiver discards the duplicate pkt1 and re-sends ACK1, which the sender (now waiting for ACK0) ignores. Correct, just wasteful.' },
    { id: 'corrupt', name: 'Corrupted packet', count: 3, fates: { S2: 'corrupt' }, desc: 'pkt1 is corrupted. The receiver re-sends ACK0. The sender, waiting for ACK1, does nothing (Λ) and the timeout triggers the retransmission.' },
    { id: 'free', name: 'Free play', count: 6, desc: 'Lose, corrupt or delay packets yourself. Try a short timeout (e.g. 18 < RTT = 20) to see premature timeouts everywhere.' },
  ],
  init(sim) { sim.S.state = 'call0'; sim.S.seq = 0; sim.R.state = 'w0'; sim.R.exp = 0; },
  onApp(sim, d) {
    const s = sim.S.seq;
    sim.trans('S', 'ack' + s, `rdt_send(${d})`, `sndpkt = make_pkt(${s}, ${d}, checksum); udt_send(sndpkt); start_timer`, `send pkt${s}, start timer`);
    sim.S.cur = { type: 'data', seq: s, data: d };
    sim.send('S', sim.S.cur);
    sim.startTimer();
  },
  onRecvS(sim, p) {
    const s = sim.S.seq;
    const st = sim.S.state;
    if (st.startsWith('call')) {
      sim.trans('S', st, 'rdt_rcv(rcvpkt)', `Λ: stale ${p.corrupt ? 'garbled packet' : 'ACK' + p.seq}, ignore`, `ignore ${p.corrupt ? 'garbled' : 'ACK' + p.seq}`, 'warn');
      return;
    }
    if (p.corrupt || p.seq !== s) {
      sim.trans('S', st, `rdt_rcv(rcvpkt) && (corrupt(rcvpkt) || isACK(rcvpkt, ${1 - s}))`, 'Λ: do nothing, wait for the timeout', p.corrupt ? 'garbled → ignore' : `ACK${p.seq} → ignore`, 'warn');
    } else {
      sim.stopTimer();
      sim.trans('S', 'call' + (1 - s), `rdt_rcv(rcvpkt) && notcorrupt(rcvpkt) && isACK(rcvpkt, ${s})`, 'stop_timer', `ACK${s} ✓ stop timer`, 'good');
      sim.S.seq = 1 - s;
      sim.scheduleApp();
    }
  },
  onTimeout(sim) {
    const s = sim.S.seq;
    sim.trans('S', sim.S.state, 'timeout', `udt_send(sndpkt): retransmit pkt${s}; start_timer`, `⏰ timeout → resend pkt${s}`, 'bad');
    sim.send('S', sim.S.cur, true);
    sim.startTimer();
  },
  onRecvR: nakFreeReceiver,
};

const ORDER = ['1.0', '2.0', '2.1', '2.2', '3.0'];

/* ---------------- simulator ---------------- */

class Sim {
  constructor(proto, scen, opts) {
    this.p = proto; this.scen = scen;
    this.t = 0; this.q = []; this.n = 0;
    this.msgs = []; this.timers = []; this.timer = null; this.log = []; this.delivered = [];
    this.counts = { S: 0, R: 0 };
    this.fates = scen.fates || {};
    this.pending = { S: null, R: null };
    this.total = scen.count; this.given = 0;
    this.timeout = opts.timeout || 30;
    this.S = {}; this.R = {};
    this.last = { S: null, R: null };
    proto.init(this);
    this.schedule(0, 'app');
  }
  schedule(t, type, data) {
    this.q.push({ t, type, data, n: this.n++ });
    this.q.sort((a, b) => a.t - b.t || a.n - b.n);
  }
  scheduleApp(gap = GAP) { if (this.given < this.total) this.schedule(this.t + gap, 'app'); }
  done() { return this.q.length === 0; }
  nextStop() {
    const e = this.q.find(e => e.type !== 'mid' || e.data.fate === 'lost');
    return e ? e.t : null;
  }
  advanceTo(T) {
    while (this.q.length && this.q[0].t <= T + 1e-9) {
      const e = this.q.shift();
      this.t = e.t;
      this.handle(e);
    }
    this.t = Math.max(this.t, T);
  }
  handle(e) {
    if (e.type === 'app') {
      if (this.given < this.total) { this.given++; this.p.onApp(this, 'D' + this.given); }
    } else if (e.type === 'mid') {
      const m = e.data;
      if (m.fate === 'lost') { m.lostAt = this.t; this.addLog('C', `${m.label} lost in the channel`, 'bad'); }
    } else if (e.type === 'arrive') {
      const m = e.data;
      if (m.fate === 'lost') return;
      m.arrived = true;
      const pkt = Object.assign({}, m.pkt, { corrupt: m.fate === 'corrupt' });
      if (m.from === 'S') this.p.onRecvR(this, pkt, m); else this.p.onRecvS(this, pkt, m);
    } else if (e.type === 'timeout') {
      const tm = e.data;
      if (tm.end != null) return;
      tm.end = this.t; tm.how = 'timeout'; this.timer = null;
      this.p.onTimeout(this);
    }
  }
  send(from, pkt, retx = false) {
    this.counts[from]++;
    const id = from + this.counts[from];
    let fate = this.fates[id] || 'ok';
    if (this.pending[from]) { fate = this.pending[from]; this.pending[from] = null; }
    let delay = D;
    if (fate === 'delay') { delay = LONG_DELAY; fate = 'ok'; }
    const kind = pkt.type === 'data' ? 'data' : pkt.type === 'NAK' ? 'nak' : 'ack';
    const label = pkt.type === 'data'
      ? `pkt${pkt.seq === undefined ? '' : pkt.seq} · ${pkt.data}`
      : pkt.type === 'NAK' ? 'NAK' : ack(pkt.seq);
    const m = { id, from, pkt, kind, label, retx, t0: this.t, t1: this.t + delay, fate, delayed: delay !== D };
    this.msgs.push(m);
    this.schedule(this.t + delay / 2, 'mid', m);
    this.schedule(this.t + delay, 'arrive', m);
    return m;
  }
  startTimer() {
    const tm = { start: this.t, end: null, how: null };
    this.timer = tm; this.timers.push(tm);
    this.schedule(this.t + this.timeout, 'timeout', tm);
  }
  stopTimer() {
    if (this.timer) {
      const tm = this.timer;
      tm.end = this.t; tm.how = 'stop'; this.timer = null;
      this.q = this.q.filter(e => e.data !== tm);
    }
  }
  trans(side, to, ev, ac, note, kind = 'info') {
    const from = (side === 'S' ? this.S : this.R).state;
    (side === 'S' ? this.S : this.R).state = to;
    this.last[side] = { from, to, ev, ac, t: this.t };
    this.addLog(side, `${ev}  ⟹  ${ac}`, kind, note);
  }
  addLog(side, text, kind = 'info', note) { this.log.push({ t: this.t, side, text, kind, note }); }
  isDelivered(d) { return this.delivered.some(x => x.data === d); }
  deliver(d) { this.delivered.push({ data: d, t: this.t, dup: this.isDelivered(d) }); }
  canSetFate(m, fate) {
    if (m.arrived || this.t >= m.t1) return false;
    if (fate === 'lost' && this.t >= m.t0 + (m.t1 - m.t0) / 2) return false;
    return true;
  }
}

if (typeof module !== 'undefined') module.exports = { P, Sim, ORDER };

/* ---------------- UI ---------------- */

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ui = { proto: '1.0', scen: null, sim: null, playing: false, speed: 8, stopAt: null, lastTs: null, logLen: -1, delLen: -1 };
  const yT = t => Y0 + t * PX;

  /* ---- tabs / scenarios / info ---- */
  function buildTabs() {
    $('protoTabs').innerHTML = ORDER.map(k => `<button class="tab${k === ui.proto ? ' on' : ''}" data-k="${k}">${P[k].name}</button>`).join('');
  }
  $('protoTabs').addEventListener('click', e => {
    const b = e.target.closest('.tab'); if (!b) return;
    selectProto(b.dataset.k);
  });

  function selectProto(k) {
    ui.proto = k;
    const p = P[k];
    buildTabs();
    $('info').innerHTML = `<h2>${esc(p.title)}</h2><p class="sub">${esc(p.sub)}</p><div class="info-grid">` +
      p.info.map(([h, items]) => `<div><b>${esc(h)}</b><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('') + '</div>';
    $('scenarios').innerHTML = p.scenarios.map(s => `<button class="chip" data-id="${s.id}">${esc(s.name)}</button>`).join('');
    $('toWrap').style.display = k === '3.0' ? '' : 'none';
    $('injectRow').style.display = p.fates.length ? '' : 'none';
    $('util').innerHTML = k === '3.0' ? utilHTML() : '';
    if (k === '3.0') bindUtil();
    if (location.hash !== '#' + k) history.replaceState(null, '', '#' + k);
    selectScen(p.scenarios[0].id);
  }
  $('scenarios').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    selectScen(b.dataset.id);
  });
  function selectScen(id) {
    ui.scen = P[ui.proto].scenarios.find(s => s.id === id);
    [...$('scenarios').children].forEach(c => c.classList.toggle('on', c.dataset.id === id));
    $('scenDesc').textContent = ui.scen.desc;
    reset(true);
  }

  /* ---- injection ---- */
  const FATE_LABEL = { ok: 'normal', corrupt: '⚡ corrupt', lost: '✕ lose', delay: '🐢 delay' };
  function buildInject() {
    const p = P[ui.proto];
    const mk = side => ['ok', ...p.fates].map(f => {
      const on = (ui.sim.pending[side] || 'ok') === f;
      return `<button class="chip${f !== 'ok' ? ' inj' : ''}${on ? ' on' : ''}" data-side="${side}" data-f="${f}">${FATE_LABEL[f]}</button>`;
    }).join('');
    $('injS').innerHTML = mk('S');
    $('injR').innerHTML = mk('R');
  }
  $('injectRow').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    ui.sim.pending[b.dataset.side] = b.dataset.f === 'ok' ? null : b.dataset.f;
    buildInject();
  });

  /* ---- controls ---- */
  function reset(autoplay) {
    const to = Math.max(12, Math.min(80, +$('timeout').value || 30));
    ui.sim = new Sim(P[ui.proto], ui.scen, { timeout: to });
    ui.logLen = -1; ui.delLen = -1; ui.stopAt = null;
    ui.playing = !!autoplay;
    $('tlScroll').scrollTop = 0;
    buildInject();
    render();
  }
  function setPlay(on) { ui.playing = on; if (!on) ui.stopAt = null; updatePlayBtn(); }
  function updatePlayBtn() { $('btnPlay').textContent = ui.playing ? '⏸ Pause' : (ui.sim.done() ? '↺ Replay' : '▶ Play'); }
  function play() {
    if (ui.sim.done()) { reset(true); return; }
    setPlay(!ui.playing);
  }
  function step() {
    if (ui.sim.done()) return;
    const s = ui.sim.nextStop();
    if (s == null) return;
    ui.stopAt = s; ui.playing = true; updatePlayBtn();
  }
  function finish() {
    let guard = 0;
    while (!ui.sim.done() && guard++ < 1000) ui.sim.advanceTo(ui.sim.q[0].t);
    setPlay(false); render();
    const sc = $('tlScroll'); sc.scrollTop = sc.scrollHeight;
  }
  $('btnPlay').onclick = play;
  $('btnStep').onclick = step;
  $('btnEnd').onclick = finish;
  $('btnReset').onclick = () => reset(true);
  $('speed').oninput = e => { ui.speed = +e.target.value; $('speedVal').textContent = ui.speed; };
  $('timeout').onchange = () => reset(true);
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(); }
    else if (e.key === 'r' || e.key === 'R') reset(true);
  });

  // click a packet in flight to cycle its fate
  $('tl').addEventListener('pointerdown', e => {
    const g = e.target.closest('[data-mid]'); if (!g) return;
    const m = ui.sim.msgs.find(x => x.id === g.dataset.mid); if (!m) return;
    const cycle = ['ok', ...P[ui.proto].fates.filter(f => f !== 'delay')];
    let i = cycle.indexOf(m.fate);
    for (let k = 1; k <= cycle.length; k++) {
      const f = cycle[(i + k) % cycle.length];
      if (f === 'ok' || ui.sim.canSetFate(m, f)) { m.fate = f; break; }
    }
    render();
  });

  /* ---- main loop ---- */
  function frame(ts) {
    if (ui.playing) {
      const dt = ui.lastTs != null ? Math.min(0.1, (ts - ui.lastTs) / 1000) : 0;
      let target = ui.sim.t + dt * ui.speed;
      if (ui.stopAt != null && target >= ui.stopAt) { target = ui.stopAt; ui.playing = false; ui.stopAt = null; }
      ui.sim.advanceTo(target);
      if (ui.sim.done()) ui.playing = false;
      render();
      follow();
    }
    ui.lastTs = ts;
    requestAnimationFrame(frame);
  }
  function follow() {
    const sc = $('tlScroll');
    const y = yT(ui.sim.t);
    if (y > sc.scrollTop + sc.clientHeight * 0.75) sc.scrollTop = y - sc.clientHeight * 0.75;
  }

  /* ---- rendering ---- */
  function render() {
    const sim = ui.sim;
    $('clock').textContent = `t = ${sim.t.toFixed(1)}`;
    updatePlayBtn();
    renderTimeline();
    renderFSM($('fsmS'), ui.sim.p.sStates, ui.sim.p.sEdges, sim.S.state, sim.last.S, 'S');
    renderFSM($('fsmR'), ui.sim.p.rStates, ui.sim.p.rEdges, sim.R.state, sim.last.R, 'R');
    renderTrans('transS', sim.last.S, sim.S, ui.sim.p.sStates);
    renderTrans('transR', sim.last.R, sim.R, ui.sim.p.rStates);
    if (sim.log.length !== ui.logLen) { ui.logLen = sim.log.length; renderLog(); renderNarr(); buildInject(); }
    if (sim.delivered.length !== ui.delLen) { ui.delLen = sim.delivered.length; renderDelivered(); }
    if (sim.done() && !ui.finishedShown) renderNarr();
  }

  function renderTrans(id, last, st, states) {
    const name = (states.find(s => s[0] === st.state) || [, ''])[1].replace(/\n/g, ' ');
    if (!last) { $(id).innerHTML = `<div class="t-st">Initial state: <b>${esc(name)}</b></div><div class="t-st">No transition taken yet.</div>`; return; }
    const html = `<div class="t-ev">${esc(last.ev)}</div><div class="t-ac">⟹ ${esc(last.ac)}</div><div class="t-st">at t = ${last.t.toFixed(1)} · now in <b>${esc(name)}</b></div>`;
    if ($(id).innerHTML !== html) $(id).innerHTML = html;
  }

  function renderLog() {
    const sim = ui.sim;
    const sideName = { S: 'SENDER', R: 'RECEIVER', C: 'CHANNEL' };
    $('log').innerHTML = sim.log.map(l => `<li class="${l.kind}"><span class="lt">${l.t.toFixed(1)}</span><span class="ls ${l.side}">${sideName[l.side]}</span><span class="lx">${esc(l.text)}</span></li>`).join('');
    $('log').scrollTop = $('log').scrollHeight;
  }
  function renderNarr() {
    const sim = ui.sim;
    const n = $('narr');
    if (sim.done()) {
      const dups = sim.delivered.filter(d => d.dup).length;
      const ok = !dups && sim.delivered.length === sim.total;
      n.className = 'card narr ' + (ok ? 'good' : 'bad');
      n.innerHTML = `<span class="tag">DONE</span><span>${ok
        ? `All ${sim.total} chunks delivered exactly once, in order, at t = ${sim.t.toFixed(1)}. Transmissions: ${sim.counts.S} data, ${sim.counts.R} feedback.`
        : `Finished, but the app got ${sim.delivered.map(d => d.data).join(', ')}. ${dups} duplicate${dups === 1 ? '' : 's'} delivered: the protocol failed.`}</span>`;
      return;
    }
    const l = sim.log[sim.log.length - 1];
    if (!l) { n.className = 'card narr'; n.innerHTML = '<span class="tag">READY</span><span>Press ▶ Play (or Space) to start.</span>'; return; }
    const sideName = { S: 'SENDER', R: 'RECEIVER', C: 'CHANNEL' };
    n.className = 'card narr ' + l.kind;
    n.innerHTML = `<span class="tag">${sideName[l.side]} · t=${l.t.toFixed(1)}</span><span>${esc(l.text)}</span>`;
  }
  function renderDelivered() {
    const d = ui.sim.delivered;
    $('delivered').innerHTML = d.length ? d.map(x => `<span class="dchip${x.dup ? ' dup' : ''}" title="t=${x.t.toFixed(1)}">${x.data}${x.dup ? ' (dup!)' : ''}</span>`).join('') : '<span class="hint">nothing yet</span>';
  }

  function renderTimeline() {
    const sim = ui.sim, t = sim.t;
    const endT = Math.max(t + 20, 70);
    const H = yT(endT) + 20;
    const svg = $('tl');
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 640 ${H}`);
    const o = [];
    o.push(`<defs>
      <marker id="ah-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#58a6ff"/></marker>
      <marker id="ah-ack" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#3fb950"/></marker>
      <marker id="ah-nak" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#f0883e"/></marker>
      <marker id="ah-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ff5c7a"/></marker>
    </defs>`);
    for (let k = 0; k <= endT; k += 10) {
      o.push(`<line class="tickline" x1="40" x2="600" y1="${yT(k)}" y2="${yT(k)}"/><text class="tick" x="4" y="${yT(k) + 3}">${k}</text>`);
    }
    o.push(`<line class="life" x1="${XS}" x2="${XS}" y1="${Y0 - 10}" y2="${H}"/><line class="life" x1="${XR}" x2="${XR}" y1="${Y0 - 10}" y2="${H}"/>`);

    // timers
    for (const tm of sim.timers) {
      const y1 = yT(tm.start), y2 = yT(tm.end != null ? tm.end : t);
      const cls = tm.how === 'timeout' ? 'timer fired' : tm.how === 'stop' ? 'timer done' : 'timer';
      o.push(`<rect class="${cls}" x="${XS - 13}" y="${y1}" width="6" height="${Math.max(0, y2 - y1)}" rx="2"/>`);
    }

    // messages
    for (const m of sim.msgs) {
      const xa = m.from === 'S' ? XS : XR, xb = m.from === 'S' ? XR : XS;
      const ya = yT(m.t0), yb = yT(m.t1);
      let f = Math.min(1, (t - m.t0) / (m.t1 - m.t0));
      const lostShown = m.fate === 'lost' && f >= 0.5;
      if (m.fate === 'lost') f = Math.min(f, 0.5);
      const xh = xa + (xb - xa) * f, yh = ya + (yb - ya) * f;
      const bad = m.fate === 'corrupt';
      const cls = `msg ${m.kind}${bad ? ' corrupt' : ''}`;
      const marker = lostShown ? '' : `marker-end="url(#ah-${bad ? 'bad' : m.kind})"`;
      const inflight = !m.arrived && !lostShown && t < m.t1;
      o.push(`<g ${inflight ? `data-mid="${m.id}"` : ''}>`);
      if (f > 0) o.push(`<line class="${cls}" x1="${xa}" y1="${ya}" x2="${xh}" y2="${yh}" ${marker}/>`);
      if (inflight) o.push(`<line class="hit" x1="${xa}" y1="${ya}" x2="${xh}" y2="${yh}"/><circle class="hit" cx="${xh}" cy="${yh}" r="10" style="fill:transparent"/>`);
      // label
      const lf = m.fate === 'lost' ? 0.28 : 0.42;
      if (f >= lf) {
        const lx = xa + (xb - xa) * lf, ly = ya + (yb - ya) * lf;
        const txt = (m.retx ? '↻ ' : '') + m.label + (bad ? ' ⚡' : '') + (m.delayed ? ' (delayed)' : '');
        const w = txt.length * 6.6 + 10;
        o.push(`<rect class="lblbg" x="${lx - w / 2}" y="${ly - 9}" width="${w}" height="16" rx="4"/><text class="mlabel ${bad ? 'corrupt' : m.kind}" x="${lx}" y="${ly + 3}" text-anchor="middle">${esc(txt)}</text>`);
      }
      if (lostShown) {
        o.push(`<text class="xmark" x="${xh}" y="${yh + 6}" text-anchor="middle">✕</text><text class="note bad" x="${xh}" y="${yh + 20}" text-anchor="middle">lost</text>`);
      }
      o.push('</g>');
    }

    // annotations
    const lastY = { S: -99, R: -99 };
    for (const l of sim.log) {
      if (!l.note || l.side === 'C') continue;
      let y = yT(l.t) + 4;
      if (y < lastY[l.side] + 13) y = lastY[l.side] + 13;
      lastY[l.side] = y;
      const x = l.side === 'S' ? XS - 20 : XR + 12;
      o.push(`<text class="note ${l.kind}" x="${x}" y="${y}" text-anchor="${l.side === 'S' ? 'end' : 'start'}">${esc(l.note)}</text>`);
    }
    // timeout markers
    for (const tm of sim.timers) if (tm.how === 'timeout') o.push(`<circle cx="${XS - 10}" cy="${yT(tm.end)}" r="3.5" fill="#ff5c7a"/>`);

    o.push(`<line class="now" x1="30" x2="610" y1="${yT(t)}" y2="${yT(t)}"/>`);
    svg.innerHTML = o.join('');
  }

  /* ---- FSM drawing ---- */
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    mul: (a, k) => [a[0] * k, a[1] * k], len: a => Math.hypot(a[0], a[1]),
    norm: a => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; },
    rot: (a, deg) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [a[0] * c - a[1] * s, a[0] * s + a[1] * c]; },
  };
  const R0 = 42;
  function layout(n) {
    if (n === 1) return { w: 420, h: 250, c: [210, 160], pos: [[210, 160]], bend: 0 };
    if (n === 2) return { w: 420, h: 270, c: [210, 165], pos: [[110, 165], [310, 165]], bend: -42 };
    return { w: 460, h: 400, c: [230, 205], pos: [[110, 140], [350, 140], [350, 275], [110, 275]], bend: 0 };
  }
  function labelSVG(x, y, lines, out, on) {
    let anchor = 'middle';
    if (Math.abs(out[0]) > 0.5) anchor = out[0] > 0 ? 'start' : 'end';
    const lh = 11;
    let y0;
    if (out[1] < -0.5) y0 = y - (lines.length - 1) * lh;
    else if (out[1] > 0.5) y0 = y + 8;
    else y0 = y - ((lines.length - 1) * lh) / 2 + 3;
    return lines.map((ln, i) => `<text class="elab${on ? ' on' : ''}" x="${x}" y="${y0 + i * lh}" text-anchor="${anchor}">${esc(ln)}</text>`).join('');
  }
  function renderFSM(svg, states, edges, cur, last, side) {
    const L = layout(states.length);
    svg.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`);
    const idx = Object.fromEntries(states.map((s, i) => [s[0], i]));
    const o = [`<defs>
      <marker id="fa-${side}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#56657a"/></marker>
      <marker id="fo-${side}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#f5b84b"/></marker>
    </defs>`];
    for (const e of edges) {
      const on = last && last.from === e.from && last.to === e.to;
      const mk = `marker-end="url(#${on ? 'fo' : 'fa'}-${side})"`;
      const A = L.pos[idx[e.from]], B = L.pos[idx[e.to]];
      if (e.from === e.to) {
        let u = states.length === 4 && A[1] > L.c[1] ? [0, 1] : [0, -1];
        const a1 = V.add(A, V.mul(V.rot(u, -28), R0)), a2 = V.add(A, V.mul(V.rot(u, 28), R0));
        const c1 = V.add(A, V.mul(V.rot(u, -42), R0 + 52)), c2 = V.add(A, V.mul(V.rot(u, 42), R0 + 52));
        o.push(`<path class="edge${on ? ' on' : ''}" d="M${a1} C${c1} ${c2} ${a2}" ${mk}/>`);
        const lp = V.add(A, V.mul(u, R0 + 46));
        o.push(labelSVG(lp[0], lp[1], e.lines, u, on));
      } else {
        const d = V.sub(B, A), nrm = V.norm([-d[1], d[0]]);
        const mid = V.mul(V.add(A, B), 0.5);
        const C = V.add(mid, V.mul(nrm, L.bend));
        const s = V.add(A, V.mul(V.norm(V.sub(C, A)), R0));
        const t = V.add(B, V.mul(V.norm(V.sub(C, B)), R0 + 2));
        o.push(`<path class="edge${on ? ' on' : ''}" d="M${s} Q${C} ${t}" ${mk}/>`);
        const M = V.add(V.add(V.mul(s, 0.25), V.mul(C, 0.5)), V.mul(t, 0.25));
        let out = V.norm(V.sub(M, L.c));
        if (V.len(V.sub(M, L.c)) < 1) out = nrm;
        const lp = V.add(M, V.mul(out, 10));
        o.push(labelSVG(lp[0], lp[1], e.lines, out, on));
      }
    }
    // initial-state arrow
    const P0 = L.pos[0];
    const init = states.length === 1 ? [P0[0] - R0 - 40, P0[1]] : states.length === 2 ? [P0[0] - 40, P0[1] + R0 + 40] : [P0[0] - R0 - 30, P0[1] - R0 - 18];
    const initEnd = V.add(P0, V.mul(V.norm(V.sub(init, P0)), R0 + 2));
    o.push(`<line class="init" x1="${init[0]}" y1="${init[1]}" x2="${initEnd[0]}" y2="${initEnd[1]}" marker-end="url(#fa-${side})"/>`);
    states.forEach(([id, name], i) => {
      const [x, y] = L.pos[i];
      const on = id === cur;
      const lines = name.split('\n');
      o.push(`<circle class="st${on ? ' on' : ''}" cx="${x}" cy="${y}" r="${R0}"/>`);
      lines.forEach((ln, j) => o.push(`<text class="st-t${on ? ' on' : ''}" x="${x}" y="${y + (j - (lines.length - 1) / 2) * 12 + 4}" text-anchor="middle">${esc(ln)}</text>`));
    });
    svg.innerHTML = o.join('');
  }

  /* ---- stop-and-wait utilization calculator (rdt 3.0) ---- */
  function utilHTML() {
    return `<h3 style="margin-top:6px">Stop-and-wait utilization</h3>
      <div>L <input id="uL" type="number" value="8000"> bits · R <input id="uR" type="number" value="1000000000"> bps · RTT <input id="uRTT" type="number" value="30" step="any"> ms</div>
      <div class="res" id="uRes"></div>`;
  }
  function bindUtil() {
    const calc = () => {
      const L = +$('uL').value, R = +$('uR').value, rtt = +$('uRTT').value / 1000;
      if (!(L > 0 && R > 0 && rtt >= 0)) { $('uRes').textContent = '—'; return; }
      const dt = L / R, U = dt / (rtt + dt), thr = L / (rtt + dt);
      $('uRes').innerHTML = `L/R = ${(dt * 1e3).toPrecision(4)} ms<br>U<sub>sender</sub> = (L/R)/(RTT + L/R) = <b>${U.toPrecision(3)}</b><br>throughput = L/(RTT + L/R) = ${(thr / 1e3).toPrecision(4)} kbps (${(thr / 8e3).toPrecision(4)} kB/s)`;
    };
    ['uL', 'uR', 'uRTT'].forEach(id => $(id).oninput = calc);
    calc();
  }

  /* ---- boot ---- */
  const h = location.hash.slice(1);
  selectProto(ORDER.includes(h) ? h : '1.0');
  requestAnimationFrame(frame);
}
