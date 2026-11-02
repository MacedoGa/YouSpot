// Cliente Socket.IO v4 mínimo (Engine.IO v4, transporte websocket) usando o
// WebSocket global do Node 22. Sem dependências externas.
//
// connect(url, { sid, auth }) -> Promise<{ emit, on, off, waitFor, close, last, id }>
//   emit(ev, payload, { timeoutMs }) -> Promise<ack>
//   on(ev, fn) / off(ev, fn)
//   waitFor(ev, predicate?, timeoutMs?) -> Promise<payload>  (considera também o último payload recebido)
//   last(ev) -> último payload recebido para o evento (ou undefined)
//   close()

function connect(url, { sid, auth, timeoutMs = 5000 } = {}) {
  const base = String(url).replace(/^http/, 'ws').replace(/\/$/, '');
  const wsUrl = `${base}/socket.io/?EIO=4&transport=websocket`;
  const handshakeAuth = auth || (sid ? { sid } : {});

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const listeners = new Map(); // ev -> Set<fn>
    const lastByEvent = new Map(); // ev -> { payload, at }
    const pendingAcks = new Map(); // id -> { resolve, reject, timer }
    const waiters = new Set();
    let nextAckId = 0;
    let connected = false;
    let closed = false;
    let socketId = null;

    const fail = (err) => {
      if (!connected) {
        closed = true;
        try { ws.close(); } catch {}
        reject(err);
      }
    };
    const openTimer = setTimeout(() => fail(new Error(`timeout conectando em ${wsUrl}`)), timeoutMs);

    const dispatch = (ev, args) => {
      lastByEvent.set(ev, { payload: args[0], args, at: Date.now() });
      for (const fn of listeners.get(ev) || []) {
        try { fn(...args); } catch (err) { console.error('listener error', err); }
      }
      for (const w of [...waiters]) {
        if (w.ev !== ev) continue;
        let ok = false;
        try { ok = !w.predicate || w.predicate(args[0]); } catch {}
        if (ok) w.done(null, args[0]);
      }
    };

    const send = (s) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(s);
    };

    ws.addEventListener('error', (e) => fail(new Error(`erro no websocket: ${e.message || 'desconhecido'}`)));
    ws.addEventListener('close', () => {
      closed = true;
      for (const { reject: rj, timer } of pendingAcks.values()) {
        clearTimeout(timer);
        rj(new Error('socket fechado antes do ack'));
      }
      pendingAcks.clear();
      for (const w of [...waiters]) w.done(new Error(`socket fechado esperando "${w.ev}"`));
      fail(new Error('socket fechado antes de conectar'));
    });

    ws.addEventListener('message', (msg) => {
      const data = typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString();
      const eioType = data[0];
      const rest = data.slice(1);
      if (eioType === '0') {
        // open do Engine.IO -> pede conexão no namespace "/" com auth
        send('40' + JSON.stringify(handshakeAuth));
        return;
      }
      if (eioType === '2') return send('3' + rest); // ping -> pong
      if (eioType === '1') return ws.close();
      if (eioType !== '4') return;

      const sioType = rest[0];
      let body = rest.slice(1);
      // namespace opcional ("/nsp,") — só usamos "/"
      if (body.startsWith('/')) {
        const comma = body.indexOf(',');
        body = comma === -1 ? '' : body.slice(comma + 1);
      }
      const m = /^(\d*)([\s\S]*)$/.exec(body);
      const id = m[1] ? Number(m[1]) : null;
      const json = m[2] ? JSON.parse(m[2]) : undefined;

      if (sioType === '0') {
        connected = true;
        socketId = json?.sid || null;
        clearTimeout(openTimer);
        resolve(api);
      } else if (sioType === '4') {
        clearTimeout(openTimer);
        fail(Object.assign(new Error(json?.message || 'erro de conexão'), { data: json?.data }));
      } else if (sioType === '1') {
        ws.close();
      } else if (sioType === '2') {
        const [ev, ...args] = json;
        if (id !== null) {
          // servidor pediu ack — respondemos vazio
          send(`43${id}[]`);
        }
        dispatch(ev, args);
      } else if (sioType === '3') {
        const p = pendingAcks.get(id);
        if (p) {
          pendingAcks.delete(id);
          clearTimeout(p.timer);
          p.resolve(json?.[0]);
        }
      }
    });

    const api = {
      get id() {
        return socketId;
      },
      get connected() {
        return connected && !closed;
      },
      emit(ev, payload, { timeoutMs: ackTimeout = 8000 } = {}) {
        return new Promise((res, rej) => {
          if (closed) return rej(new Error('socket fechado'));
          const id = nextAckId++;
          const timer = setTimeout(() => {
            pendingAcks.delete(id);
            rej(new Error(`timeout esperando ack de "${ev}"`));
          }, ackTimeout);
          pendingAcks.set(id, { resolve: res, reject: rej, timer });
          // como o socket.io-client faz com emit(ev, undefined, cb): o argumento vira null
          const args = [ev, payload === undefined ? null : payload];
          send(`42${id}${JSON.stringify(args)}`);
        });
      },
      on(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev).add(fn);
        return api;
      },
      off(ev, fn) {
        listeners.get(ev)?.delete(fn);
        return api;
      },
      last(ev) {
        return lastByEvent.get(ev)?.payload;
      },
      lastAt(ev) {
        return lastByEvent.get(ev)?.at;
      },
      waitFor(ev, predicate, waitTimeout = 5000) {
        const prev = lastByEvent.get(ev);
        if (prev) {
          let ok = false;
          try { ok = !predicate || predicate(prev.payload); } catch {}
          if (ok) return Promise.resolve(prev.payload);
        }
        return new Promise((res, rej) => {
          const w = {
            ev,
            predicate,
            done: (err, val) => {
              clearTimeout(w.timer);
              waiters.delete(w);
              err ? rej(err) : res(val);
            },
          };
          w.timer = setTimeout(
            () => w.done(new Error(`timeout (${waitTimeout} ms) esperando "${ev}"; último: ${JSON.stringify(prev ? lastByEvent.get(ev)?.payload : lastByEvent.get(ev)?.payload)?.slice(0, 600)}`)),
            waitTimeout
          );
          waiters.add(w);
        });
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          send('41');
          ws.close();
        } catch {}
      },
    };
  });
}

module.exports = { connect };
