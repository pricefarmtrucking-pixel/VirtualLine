
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';
import cors from 'cors';


// ---- DB bootstrap (SQLite or Postgres) ----
import pg from 'pg';

function makePgCompat(pool){
  // Replace '?' with $1.. and basic sqlite -> pg rewrites
  function rewrite(sql){
    // INSERT OR IGNORE -> ON CONFLICT DO NOTHING
    sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, (m)=>{
      return m.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
    });
    // Convert SQLite datetime('now','+X minutes/seconds')
    sql = sql.replace(/datetime\('now','\+(\d+) minutes'\)/gi, "NOW() + INTERVAL '$1 minutes'");
    sql = sql.replace(/datetime\('now','\+(\d+) seconds'\)/gi, "NOW() + INTERVAL '$1 seconds'");
    // Basic AUTOINCREMENT handled by SERIAL in schema; CURRENT_TIMESTAMP works in PG too.
    // Add an ON CONFLICT DO NOTHING when we detect patterns likely using ignore behavior
    if (/INSERT\s+INTO\s+[^;]+/i.test(sql) && /DO NOTHING/i.test(sql) === false && /ON CONFLICT/i.test(sql) === false && /OR IGNORE/i.test(sql) ){
      sql = sql + " ON CONFLICT DO NOTHING";
    }
    // Replace SQLite boolean usage if any (not needed here usually)
    // Replace '?' sequentially with $1, $2, ...
    let i = 0;
    sql = sql.replace(/\?/g, () => {
      i += 1;
      return '$' + i;
    });
    return sql;
  }
  function prepare(sql){
    const rewritten = rewrite(sql);
    return {
      async get(...params){
        const { rows } = await pool.query(rewritten, params);
        return rows[0] || undefined;
      },
      async all(...params){
        const { rows } = await pool.query(rewritten, params);
        return rows;
      },
      async run(...params){
        // Try to capture last insert id when possible by appending RETURNING id
        let q = rewritten;
        const isInsert = /^\s*insert\s+/i.test(q);
        if (isInsert && !/returning\s+id/i.test(q)){
          q = q.replace(/;?\s*$/,' RETURNING id');
        }
        try{
          const { rows, rowCount } = await pool.query(q, params);
          return { changes: rowCount, lastInsertRowid: rows && rows[0] && (rows[0].id || null) };
        }catch(err){
          // Unique violation (23505) emulate "ignore"
          if (err && err.code === '23505'){
            return { changes: 0, lastInsertRowid: null };
          }
          throw err;
        }
      }
    };
  }
  return { prepare };
}

let db;
const usePg = !!process.env.DATABASE_URL;
if (usePg){
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  db = makePgCompat(pool);
}else{
  const Database = (await import('better-sqlite3')).default;
  db = new Database('data.db');
}
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const app = express();
// db initialized by shim

// simple env loader
const ENV = {};
try {
  const txt = fs.readFileSync(path.join(__dirname,'.env'),'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) ENV[m[1]] = m[2];
  }
} catch {}

app.use(express.json());
app.use(cookieParser(ENV.SESSION_SECRET || 'secret'));
app.use(cors({ origin: ENV.CORS_ORIGIN || true, credentials: true }));

// serve static client
app.use(express.static(path.join(__dirname,'public')));

function normalizePhone(p){
  return String(p||'').replace(/[^0-9+]/g,'').replace(/^1?([0-9]{10})$/,'+1$1');
}
function minutes(hhmm){ const [h,m]=hhmm.split(':').map(Number); return h*60+m; }
function hhmm(min){ return String(Math.floor(min/60)).padStart(2,'0')+':'+String(min%60).padStart(2,'0'); }
function todayLocalISO(){ const d = new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
function expireHolds(){ db.prepare("UPDATE time_slots SET hold_token=NULL, hold_expires_at=NULL WHERE hold_expires_at IS NOT NULL AND hold_expires_at < CURRENT_TIMESTAMP").run(); }

function requireAuth(req,res,next){
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error:'auth required' });
  const s = db.prepare('SELECT phone FROM sessions WHERE token=?').get(token);
  if (!s) return res.status(401).json({ error:'invalid session' });
  const u = db.prepare('SELECT is_banned FROM users WHERE phone=?').get(s.phone);
  if (u?.is_banned) return res.status(403).json({ error:'number suspended' });
  req.user = { phone: s.phone };
  next();
}

// ---------- Auth (OTP) ----------
app.post('/auth/request-code', (req,res)=>{
  const phone = normalizePhone(req.body?.phone);
  if (!phone || phone.length < 11) return res.status(400).json({ error:'invalid phone' });
  const u = db.prepare('SELECT is_banned FROM users WHERE phone=?').get(phone);
  if (u?.is_banned) return res.status(403).json({ error:'number suspended' });

  const code = String(Math.floor(100000 + Math.random()*900000));
  const expires = db.prepare("SELECT datetime('now','+5 minutes') as e").get().e;
  db.prepare("INSERT INTO otp_codes (phone, code, expires_at, attempts_left) VALUES (?,?,?,5)").run(phone, code, expires);

  // SMS send (optional): integrate Twilio here

  res.json({ ok:true });
});

app.post('/auth/verify', (req,res)=>{
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code||'');
  if (!phone || code.length !== 6) return res.status(400).json({ error:'bad input' });

  const row = db.prepare("SELECT * FROM otp_codes WHERE phone=? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY id DESC LIMIT 1").get(phone);
  if (!row) return res.status(400).json({ error:'code expired' });
  if (row.attempts_left <= 0) return res.status(429).json({ error:'too many attempts' });
  if (row.code !== code){
    db.prepare("UPDATE otp_codes SET attempts_left=attempts_left-1 WHERE id=?").run(row.id);
    return res.status(400).json({ error:'incorrect code' });
  }
  db.prepare("INSERT OR IGNORE INTO users (phone) VALUES (?)").run(phone);
  db.prepare("UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE phone=?").run(phone);
  db.prepare("UPDATE otp_codes SET consumed_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);

  const token = crypto.randomUUID();
  db.prepare("INSERT INTO sessions (token, phone) VALUES (?,?)").run(token, phone);
  res.cookie('session', token, { httpOnly:true, sameSite:'lax', maxAge: 7*24*3600*1000 });
  res.json({ ok:true });
});

// ---------- Facility info ----------
app.get('/api/facility/info', (req,res)=>{
  const row = db.prepare('SELECT facility_phone, support_phone FROM facility_info WHERE id=1').get();
  res.json(row || {});
});
app.post('/api/facility/info', (req,res)=>{
  const { facility_phone, support_phone } = req.body || {};
  db.prepare("UPDATE facility_info SET facility_phone=?, support_phone=?, updated_at=CURRENT_TIMESTAMP WHERE id=1").run(facility_phone, support_phone);
  res.json({ ok:true });
});

// ---------- Scheduling ----------
app.post('/api/sites/:id/schedule', (req,res)=>{
  const site_id = Number(req.params.id);
  const { date, open_time, close_time, loads_target, workins_per_hour=0 } = req.body || {};
  if (!date || !open_time || !close_time || !loads_target) return res.status(400).json({ error:'missing fields' });
  const minInt = site_id === 2 ? 6 : 5; // WEST:6, EAST:5
  const start = minutes(open_time), end = minutes(close_time);
  const dur = Math.max(0, end - start);
  let interval = 0;
  if (loads_target > 1) interval = Math.max(minInt, Math.floor(dur/(loads_target-1)));

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO site_settings (site_id, date, loads_target, open_time, close_time, workins_per_hour)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(site_id, date) DO UPDATE SET loads_target=excluded.loads_target, open_time=excluded.open_time, close_time=excluded.close_time, workins_per_hour=excluded.workins_per_hour`)
      .run(site_id, date, loads_target, open_time, close_time, workins_per_hour);

    const ins = db.prepare("INSERT OR IGNORE INTO time_slots (site_id,date,slot_time,is_workin) VALUES (?,?,?,0)");
    if (loads_target >= 1){
      for (let i=0;i<loads_target;i++){
        const t = start + i*interval;
        if (t <= end) ins.run(site_id, date, hhmm(t));
      }
    }
    if (workins_per_hour > 0){
      const step = Math.floor(60 / workins_per_hour);
      for (let h = Math.floor(start/60); h <= Math.floor(end/60); h++){
        for (let k=0;k<workins_per_hour;k++){
          const minute = k*step;
          const tm = h*60 + minute;
          if (tm >= start && tm <= end){
            db.prepare("INSERT OR IGNORE INTO time_slots (site_id,date,slot_time,is_workin) VALUES (?,?,?,1)")
              .run(site_id, date, hhmm(tm));
          }
        }
      }
    }
  });
  tx();
  res.json({ ok:true, interval_min: interval });
});

app.get('/api/sites/:id/slots', (req,res)=>{
  expireHolds();
  const site_id = Number(req.params.id);
  const date = req.query?.date || todayLocalISO();
  const rows = db.prepare("SELECT slot_time FROM time_slots WHERE site_id=? AND date=? AND reserved_truck_id IS NULL AND hold_token IS NULL ORDER BY slot_time").all(site_id, date);
  res.json(rows.map(r=>r.slot_time));
});

// ---------- Hold / confirm ----------
app.post('/api/slots/hold', (req,res)=>{
  expireHolds();
  const { site_id, date, slot_time } = req.body || {};
  if (!site_id || !date || !slot_time) return res.status(400).json({ error:'missing params' });
  const row = db.prepare("SELECT id, reserved_truck_id, hold_token, hold_expires_at FROM time_slots WHERE site_id=? AND date=? AND slot_time=?").get(site_id, date, slot_time);
  if (!row) return res.status(404).json({ error:'slot not found' });
  if (row.reserved_truck_id) return res.status(409).json({ error:'slot reserved' });
  if (row.hold_token && new Date(row.hold_expires_at) > new Date()) return res.status(409).json({ error:'slot on hold' });
  const token = crypto.randomUUID();
  db.prepare("UPDATE time_slots SET hold_token=?, hold_expires_at=datetime('now','+120 seconds') WHERE id=?").run(token, row.id);
  const expires = db.prepare("SELECT hold_expires_at as e FROM time_slots WHERE id=?").get(row.id).e;
  res.json({ hold_token: token, expires_at: expires });
});

app.post('/api/slots/confirm', (req,res)=>{
  expireHolds();
  const { hold_token } = req.body || {};
  if (!hold_token) return res.status(400).json({ error:'hold_token required' });
  const slot = db.prepare("SELECT * FROM time_slots WHERE hold_token=? AND hold_expires_at > CURRENT_TIMESTAMP").get(hold_token);
  if (!slot) return res.status(410).json({ error:'hold expired or invalid' });

  const p = req.body || {};
  const manage_token = crypto.randomUUID();
  const ins = db.prepare(`INSERT INTO slot_reservations
    (site_id,date,slot_time,truck_id,license_plate,driver_name,driver_phone,vendor_name,farm_or_ticket,est_amount,est_unit,manage_token)
    VALUES (@site_id,@date,@slot_time,@truck_id,@license_plate,@driver_name,@driver_phone,@vendor_name,@farm_or_ticket,@est_amount,@est_unit,@manage_token)`);
  const info = ins.run({
    site_id: slot.site_id, date: slot.date, slot_time: slot.slot_time,
    truck_id: null,
    license_plate: p.license_plate || null,
    driver_name: p.driver_name || null,
    driver_phone: p.driver_phone || null,
    vendor_name: p.vendor_name || null,
    farm_or_ticket: p.farm_or_ticket || null,
    est_amount: p.est_amount || null,
    est_unit: (p.est_unit||'').toUpperCase() || null,
    manage_token
  });

  db.prepare("UPDATE time_slots SET reserved_truck_id=?, reserved_at=CURRENT_TIMESTAMP, hold_token=NULL, hold_expires_at=NULL WHERE id=?").run(info.lastInsertRowid, slot.id);

  res.status(201).json({ ok:true, reservation_id: info.lastInsertRowid, manage_token, slot_time: slot.slot_time });
});

app.post('/api/slots/release', (req,res)=>{
  const { hold_token } = req.body || {};
  if (!hold_token) return res.status(400).json({ error:'hold_token required' });
  db.prepare("UPDATE time_slots SET hold_token=NULL, hold_expires_at=NULL WHERE hold_token=?").run(hold_token);
  res.json({ ok:true });
});

// ---------- Reassign / cancel / mass-cancel ----------
app.post('/api/slots/reassign', (req,res)=>{
  const { reservation_id, to_slot_time } = req.body || {};
  if (!reservation_id || !to_slot_time) return res.status(400).json({ error:'missing fields' });
  const r = db.prepare("SELECT * FROM slot_reservations WHERE id=?").get(reservation_id);
  if (!r) return res.status(404).json({ error:'reservation not found' });
  const target = db.prepare("SELECT * FROM time_slots WHERE site_id=? AND date=? AND slot_time=?").get(r.site_id, r.date, to_slot_time);
  if (!target) return res.status(404).json({ error:'target slot not found' });
  if (target.reserved_truck_id) return res.status(409).json({ error:'target slot taken' });

  const tx = db.transaction(()=>{
    db.prepare("UPDATE time_slots SET reserved_truck_id=NULL, reserved_at=NULL WHERE site_id=? AND date=? AND slot_time=? AND reserved_truck_id=?").run(r.site_id, r.date, r.slot_time, r.id);
    db.prepare("UPDATE time_slots SET reserved_truck_id=?, reserved_at=CURRENT_TIMESTAMP WHERE id=?").run(r.id, target.id);
    db.prepare("UPDATE slot_reservations SET slot_time=? WHERE id=?").run(to_slot_time, reservation_id);
  });
  tx();
  res.json({ ok:true });
});

app.post('/api/slots/cancel', (req,res)=>{
  const { reservation_id, reason } = req.body || {};
  if (!reservation_id) return res.status(400).json({ error:'reservation_id required' });
  const r = db.prepare("SELECT * FROM slot_reservations WHERE id=?").get(reservation_id);
  if (!r) return res.status(404).json({ error:'not found' });
  const tx = db.transaction(()=>{
    db.prepare("UPDATE time_slots SET reserved_truck_id=NULL, reserved_at=NULL WHERE site_id=? AND date=? AND slot_time=? AND reserved_truck_id=?").run(r.site_id, r.date, r.slot_time, r.id);
    db.prepare("DELETE FROM slot_reservations WHERE id=?").run(reservation_id);
  });
  tx();
  res.json({ ok:true });
});

app.post('/api/slots/mass-cancel', (req,res)=>{
  const { site_id, date, reservation_ids=[], reason, notify=false } = req.body || {};
  if (!site_id || !date || !reservation_ids.length) return res.status(400).json({ error:'missing fields' });
  const tx = db.transaction(()=>{
    for (const id of reservation_ids){
      const r = db.prepare("SELECT * FROM slot_reservations WHERE id=? AND site_id=? AND date=?").get(id, site_id, date);
      if (!r) continue;
      db.prepare("UPDATE time_slots SET reserved_truck_id=NULL, reserved_at=NULL WHERE site_id=? AND date=? AND slot_time=? AND reserved_truck_id=?").run(site_id, date, r.slot_time, r.id);
      db.prepare("DELETE FROM slot_reservations WHERE id=?").run(id);
    }
  });
  tx();
  res.json({ ok:true, canceled: reservation_ids.length });
});

// ---------- Scale verify ----------
app.get('/api/scale/verify', (req,res)=>{
  const { code, site='EAST', date=todayLocalISO() } = req.query || {};
  if (!code || String(code).length !== 4) return res.status(400).json({ error:'code must be 4 digits' });
  const sid = site === 'WEST' ? 2 : 1;
  const row = db.prepare(`
    SELECT id, queue_code, license_plate, driver_name, status, created_at, site_id
    FROM trucks
    WHERE queue_code = ? AND site_id = ? AND checkin_date = ?
    ORDER BY id DESC LIMIT 1
  `).get(String(code), sid, date);
  if (!row) return res.status(404).json({ error:'Not found for site/date' });
  res.json(row);
});

// ---------- Appointments list for facility ----------
app.get('/api/appointments', (req,res)=>{
  const site_id = Number(req.query?.site_id);
  const date = req.query?.date || todayLocalISO();
  if (!site_id) return res.status(400).json({ error:'site_id required' });
  const rows = db.prepare("SELECT * FROM slot_reservations WHERE site_id=? AND date=? ORDER BY slot_time").all(site_id, date);
  res.json(rows);
});

// Fallback to index
app.get('*', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','index.html'));
});

const PORT = Number(process.env.PORT || ENV.PORT || 8080);
app.listen(PORT, ()=>console.log('Server running on http://localhost:'+PORT));


function requireAdmin(req,res,next){
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error:'admin only' });
  next();
}


// -------- Admin Queue APIs --------
app.get('/api/admin/queue/:site/today', requireAuth, requireAdmin, (req,res)=>{
  const siteCode = String(req.params.site||'').toUpperCase();
  const row = db.prepare('SELECT id FROM sites WHERE code=?').get(siteCode);
  if (!row) return res.status(404).json({ error:'unknown site' });
  const site_id = row.id;
  const today = new Date().toISOString().slice(0,10);
  const list = db.prepare(`SELECT id, phone, product, load_number, bill_of_lading, status, created_at, 
                                  enroute_at, arrived_at, loading_at, departed_at
                           FROM trucks
                           WHERE site_id=? AND checkin_date=?
                           ORDER BY id ASC`).all(site_id, today, typeQ);
  res.json({ ok:true, site: siteCode, count: list.length, trucks: list });
});

app.post('/api/admin/queue/update-status', requireAuth, requireAdmin, (req,res)=>{
  const body = req.body || {};
  const id = Number(body.truck_id);
  let status = String(body.status||'').toUpperCase();
  const allowed = ['EN ROUTE','ARRIVED','LOADING','DEPARTED'];
  if (!id) return res.status(400).json({ error:'truck_id required' });
  if (!allowed.includes(status)) return res.status(400).json({ error:'invalid status' });
  // normalize to single token for storage
  const status_token = status.replace(' ','_');

  const truck = db.prepare('SELECT * FROM trucks WHERE id=?').get(id);
  if (!truck) return res.status(404).json({ error:'truck not found' });

  // Set timestamp based on status
  let col = null;
  if (status === 'EN ROUTE') col = 'enroute_at';
  if (status === 'ARRIVED') col = 'arrived_at';
  if (status === 'LOADING') col = 'loading_at';
  if (status === 'DEPARTED') col = 'departed_at';

  // SQLite timestamp: CURRENT_TIMESTAMP works; PG uses NOW()
  const updateSql = col 
    ? `UPDATE trucks SET status=?, ${col}=CURRENT_TIMESTAMP WHERE id=?`
    : `UPDATE trucks SET status=? WHERE id=?`;
  db.prepare(updateSql).run(status_token, id);

  res.json({ ok:true });
});


// Driver marks En Route (optional ETA minutes)
app.post('/api/queue/enroute', (req,res)=>{
  try{
    const b=req.body||{};
    const phone=normalizePhone(b.phone);
    const site=String(b.site||'').toUpperCase();
    const etaMin = b.eta_minutes!=null ? Number(b.eta_minutes) : null;
    if (!phone) return res.status(400).json({ error:'phone required' });
    const r=db.prepare('SELECT id FROM sites WHERE code=?').get(site);
    if (!r) return res.status(404).json({ error:'unknown site' });
    const site_id=r.id;
    const today=new Date().toISOString().slice(0,10);

    // Find today's latest record for this phone or create one
    let t=db.prepare("SELECT * FROM trucks WHERE site_id=? AND checkin_date=? AND phone=? ORDER BY id DESC LIMIT 1").get(site_id,today,phone);
    if (!t){
      // create a new row with EN_ROUTE so they show up on dashboard
      const ins=db.prepare("INSERT INTO trucks (phone,status,site_id,checkin_date) VALUES (?,?,?,?)").run(phone,'EN_ROUTE',site_id,today);
      const id=ins.lastInsertRowid||null;
      if (id) db.prepare('UPDATE trucks SET queue_seq=id WHERE id=?').run(id);
      t=db.prepare("SELECT * FROM trucks WHERE id=?").get(id);
    }

    const nowStamp = "CURRENT_TIMESTAMP";
    const sqlBase = "UPDATE trucks SET status=?, enroute_at="+nowStamp;
    if (etaMin!=null && Number.isFinite(etaMin) && etaMin>0){
      // store ETA; calculate eta_at timestamp from now
      db.prepare(sqlBase + ", eta_minutes=?, eta_at=datetime('now','+'||?||' minutes') WHERE id=?").run('EN_ROUTE', etaMin, etaMin, t.id);
    }else{
      db.prepare(sqlBase + " WHERE id=?").run('EN_ROUTE', t.id);
    }
    return res.json({ ok:true });
  }catch(e){ console.error(e); return res.status(500).json({ error:'server error' }); }
});


// Public dashboard for today's line
app.get('/api/public/:site/line', (req,res)=>{
  const site=String(req.params.site||'').toUpperCase();
  const r=db.prepare('SELECT id FROM sites WHERE code=?').get(site);
  if (!r) return res.status(404).json({ error:'unknown site' });
  const site_id=r.id;
  const today=new Date().toISOString().slice(0,10);

  // queued by arrival (arrived_at if present else created_at), show masked phone
  const typeQ = String(req.query.type||'LOAD').toUpperCase();
  const queued = db.prepare(`SELECT id, phone, product, load_number, bill_of_lading, arrived_at, created_at
                             FROM trucks
                             WHERE site_id=? AND checkin_date=? AND line_type=? AND status IN ('QUEUED','ARRIVED','LOADING')
                             ORDER BY COALESCE(arrived_at, created_at) ASC`).all(site_id, today, typeQ)
                   .map(t=>({ id:t.id, phone: t.phone? (t.phone.slice(0,3)+'***'+t.phone.slice(-2)) : null,
                              product:t.product, load_number:t.load_number, bol:t.bill_of_lading,
                              arrived_at:t.arrived_at, created_at:t.created_at }));

  const en_route_count = db.prepare("SELECT COUNT(*) AS c FROM trucks WHERE site_id=? AND checkin_date=? AND line_type=? AND status='EN_ROUTE'").get(site_id, today, typeQ).c;
  const en_route_eta = db.prepare("SELECT id, phone, eta_minutes, eta_at FROM trucks WHERE site_id=? AND checkin_date=? AND status='EN_ROUTE' ORDER BY eta_at ASC NULLS LAST").all(site_id, today)
                         .map(t=>({ id:t.id, phone: t.phone? (t.phone.slice(0,3)+'***'+t.phone.slice(-2)) : null, eta_minutes:t.eta_minutes, eta_at:t.eta_at }));

  res.json({ ok:true, site, en_route_count, queued, en_route_eta });
});


// Admin history with wait-time analytics
app.get('/api/admin/history/:site', requireAuth, requireAdmin, (req,res)=>{
  const site=String(req.params.site||'').toUpperCase();
  const r=db.prepare('SELECT id FROM sites WHERE code=?').get(site);
  if (!r) return res.status(404).json({ error:'unknown site' });
  const site_id=r.id;
  const start=String(req.query.start||'').trim();
  const end=String(req.query.end||'').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)){
    return res.status(400).json({ error:'start and end required as YYYY-MM-DD' });
  }
  const typeQ = String(req.query.type||'ALL').toUpperCase();
  const rows=db.prepare(`SELECT id, phone, status, created_at, arrived_at, loading_at, departed_at, product, load_number
                         FROM trucks
                         WHERE site_id=? AND checkin_date BETWEEN ? AND ? AND (?='ALL' OR line_type=?) AND (?='ALL' OR line_type=?)
                         ORDER BY checkin_date ASC, id ASC`).all(site_id, start, end, typeQ, typeQ);

  function toMs(ts){ return ts ? (new Date(ts).getTime()) : null; }
  const enriched = rows.map(t=>{
    const arr=toMs(t.arrived_at), load=toMs(t.loading_at), dep=toMs(t.departed_at);
    const wait_ms = (arr && load) ? (load - arr) : null;
    const total_ms = (arr && dep) ? (dep - arr) : null;
    return Object.assign({}, t, { wait_ms, total_ms });
  });

  // simple averages in minutes
  const waits = enriched.map(x=>x.wait_ms).filter(Boolean);
  const totals = enriched.map(x=>x.total_ms).filter(Boolean);
  const avg = arr => arr.length? (arr.reduce((a,b)=>a+b,0)/arr.length/60000) : null;
  const analytics = { avg_wait_min: avg(waits), avg_total_min: avg(totals), n_waits: waits.length, n_totals: totals.length };

  res.json({ ok:true, site, start, end, analytics, count: rows.length, rows: enriched });
});

app.get('/api/admin/history/:site/export.csv', requireAuth, requireAdmin, (req,res)=>{
  const site=String(req.params.site||'').toUpperCase();
  const r=db.prepare('SELECT id FROM sites WHERE code=?').get(site);
  if (!r) return res.status(404).json({ error:'unknown site' });
  const site_id=r.id;
  const start=String(req.query.start||'').trim();
  const end=String(req.query.end||'').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)){
    return res.status(400).json({ error:'start and end required as YYYY-MM-DD' });
  }
  const typeQ = String(req.query.type||'ALL').toUpperCase();
  const list=db.prepare(`SELECT id, phone, product, load_number, status, created_at, arrived_at, loading_at, departed_at
                         FROM trucks
                         WHERE site_id=? AND checkin_date BETWEEN ? AND ? AND (?='ALL' OR line_type=?)
                         ORDER BY checkin_date ASC, id ASC`).all(site_id, start, end, typeQ, typeQ);
  const header=['id','phone','product','load_number','status','created_at','arrived_at','loading_at','departed_at'];
  const rows=[header.join(',')].concat(list.map(t=>header.map(h=> (t[h]??'').toString().replace(/,/g,' ')).join(',')));
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${site}-${start}_to_${end}-history.csv"`);
  res.send(rows.join('\n'));
});

// Admin helper: set ETA minutes on a truck (and eta_at timestamp)
app.post('/api/admin/queue/set-eta', requireAuth, requireAdmin, (req,res)=>{
  const id = Number(req.body?.truck_id);
  const eta = Number(req.body?.eta_minutes);
  if (!id || !Number.isFinite(eta) || eta<=0) return res.status(400).json({ error:'truck_id and positive eta_minutes required' });
  // SQLite datetime expression; PG is handled by pg shim rewrite
  db.prepare("UPDATE trucks SET eta_minutes=?, eta_at=datetime('now','+'||?||' minutes') WHERE id=?").run(eta, eta, id);
  res.json({ ok:true });
});

// ---- Scheduler: anomaly alerts (ETA passed, long waits) & daily digest ----
function minutesSince(ts){ if(!ts) return null; return Math.floor((Date.now()-new Date(ts).getTime())/60000); }

const ALERT_WAIT_MIN = Number(process.env.ALERT_WAIT_MIN||90); // minutes
const CHECK_PERIOD_MS = 60*1000; // 1 minute
let lastDigestDate = null;

async function sendSMS(to, body){
  const sid=process.env.TWILIO_ACCOUNT_SID, token=process.env.TWILIO_AUTH_TOKEN;
  const from=process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM;
  if (sid && token && from){
    const twilio=(await import('twilio')).default(sid,token);
    const opts=(process.env.TWILIO_MESSAGING_SERVICE_SID)? { messagingServiceSid: from, to, body } : { from, to, body };
    await twilio.messages.create(opts);
    return true;
  } else { console.log('[SMS stub]', to, body); return false; }
}

async function sendEmail(subject, html){
  try{
    const host=process.env.SMTP_HOST, port=Number(process.env.SMTP_PORT||587), user=process.env.SMTP_USER, pass=process.env.SMTP_PASS, to=process.env.DIGEST_TO;
    if (!host || !user || !pass || !to){ console.log('[Email stub]', subject); return false; }
    const nodemailer = (await import('nodemailer')).default;
    const tx = nodemailer.createTransport({ host, port, secure: false, auth: { user, pass } });
    await tx.sendMail({ from: user, to, subject, html });
    return true;
  }catch(e){ console.error('Email failed', e); return false; }
}

async function anomalyTick(){
  try{
    const nowISO = new Date().toISOString();
    const sites = db.prepare("SELECT id, code, name FROM sites").all();
    for (const s of sites){
      const today = new Date().toISOString().slice(0,10);
      // ETA passed
      const due = db.prepare("SELECT id, phone, eta_minutes, eta_at FROM trucks WHERE site_id=? AND checkin_date=? AND status='EN_ROUTE' AND eta_at IS NOT NULL AND eta_at < ? AND (eta_prompted_at IS NULL)").all(s.id, today, nowISO);
      for (const t of due){
        const link = `${process.env.BASE_URL||''}/driver-eta.html?truck=${t.id}`;
        const msg = `Your ETA has passed. Have you arrived? Update here: ${link}`;
        try{
          await sendSMS(t.phone, msg);
          db.prepare("UPDATE trucks SET eta_prompted_at=CURRENT_TIMESTAMP, last_eta_sms_at=CURRENT_TIMESTAMP WHERE id=?").run(t.id);
          db.prepare("INSERT INTO notifications (truck_id, type, message) VALUES (?,?,?)").run(t.id, 'ETA_EXPIRED', msg);
        }catch(e){ console.error('ETA prompt SMS failed', e); }
      }
      // Long waits
      const stuck = db.prepare("SELECT id, phone, arrived_at FROM trucks WHERE site_id=? AND checkin_date=? AND status='ARRIVED' AND arrived_at IS NOT NULL").all(s.id, today);
      for (const t of stuck){
        const min = minutesSince(t.arrived_at);
        if (min!=null && min>=ALERT_WAIT_MIN){
          const seen = db.prepare("SELECT id FROM notifications WHERE truck_id=? AND type='LONG_WAIT'").get(t.id);
          if (!seen){
            const to = process.env.ALERT_SMS_TO || process.env.ADMIN_PHONE;
            if (to){
              const msg = `[${s.code}] Truck ${t.phone} waiting ${min} min since arrival.`;
              try{
                await sendSMS(to, msg);
                db.prepare("INSERT INTO notifications (truck_id, type, message) VALUES (?,?,?)").run(t.id, 'LONG_WAIT', msg);
              }catch(e){ console.error('Admin long-wait SMS failed', e); }
            }
          }
        }
      }
    }
    // Daily digest
    const digestHour = Number(process.env.DIGEST_HOUR_LOCAL||18);
    const now = new Date();
    if (now.getHours() === digestHour){
      const dateKey = now.toISOString().slice(0,10);
      if (lastDigestDate !== dateKey){
        lastDigestDate = dateKey;
        await sendDailyDigest();
      }
    }
  }catch(e){ console.error('anomalyTick error', e); }
}

async function sendDailyDigest(){
  const today = new Date().toISOString().slice(0,10);
  const sites = db.prepare("SELECT id, code, name FROM sites").all();
  let htmlBlocks = [];
  for (const s of sites){
    const totals = db.prepare("SELECT COUNT(*) AS c FROM trucks WHERE site_id=? AND checkin_date=?").get(s.id, today).c;
    const enroute = db.prepare("SELECT COUNT(*) AS c FROM trucks WHERE site_id=? AND checkin_date=? AND status='EN_ROUTE'").get(s.id, today).c;
    const arrived = db.prepare("SELECT COUNT(*) AS c FROM trucks WHERE site_id=? AND checkin_date=? AND status='ARRIVED'").get(s.id, today).c;
    const loading = db.prepare("SELECT COUNT(*) AS c FROM trucks WHERE site_id=? AND checkin_date=? AND status='LOADING'").get(s.id, today).c;
    const departed = db.prepare("SELECT COUNT(*) AS c FROM trucks WHERE site_id=? AND checkin_date=? AND status='DEPARTED'").get(s.id, today).c;

    const rows = db.prepare("SELECT arrived_at, loading_at, departed_at FROM trucks WHERE site_id=? AND checkin_date=?").all(s.id, today);
    const toMs = (x)=> x? new Date(x).getTime(): null;
    const waits = rows.map(r=> (r.arrived_at&&r.loading_at)? (toMs(r.loading_at)-toMs(r.arrived_at)) : null).filter(Boolean);
    const totalsMs = rows.map(r=> (r.arrived_at&&r.departed_at)? (toMs(r.departed_at)-toMs(r.arrived_at)) : null).filter(Boolean);
    const avg = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length/60000).toFixed(1) : '—';

    htmlBlocks.push(`<h3>${s.code} — ${s.name}</h3>
      <ul>
        <li>En Route: ${enroute}</li>
        <li>Arrived: ${arrived}</li>
        <li>Loading: ${loading}</li>
        <li>Departed: ${departed}</li>
        <li>Avg Wait (Arrived→Loading): ${avg(waits)} min</li>
        <li>Avg Total (Arrived→Departed): ${avg(totalsMs)} min</li>
      </ul>`);
  }
  const html = `<div><h2>Daily Digest — ${today}</h2>${htmlBlocks.join('')}</div>`;
  const to = process.env.DIGEST_SMS_TO || process.env.ADMIN_PHONE;
  if (to){
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim();
    await sendSMS(to, `Daily Digest ${today}: ${text}`.slice(0,1500));
  }
  await sendEmail(`Daily Digest — ${today}`, html);
}

setInterval(()=>{ anomalyTick(); }, CHECK_PERIOD_MS);


// ---- Twilio inbound SMS webhook ----
import querystring from 'querystring';
app.post('/twilio/sms', express.urlencoded({ extended:false }), async (req, res) => {
  try{
    const from = normalizePhone(req.body?.From || req.body?.from || '');
    const body = String(req.body?.Body || req.body?.body || '').trim();
    if (!from || !body){ res.type('text/xml').send('<Response><Message>Missing from/body</Message></Response>'); return; }

    // Commands: ARRIVED | LOADING/UNLOADING | DEPARTED | ETA <minutes> | CANCEL | HELP | (site code CIF/CCR; keyword DELIVER)
    const U = body.trim().toUpperCase();
    const mEta = U.match(/^ETA\s+(\d{1,3})\b/);
    const cmd = mEta ? 'ETA' : (U.split(/[\s,]+/)[0] || '');

    // find today's latest truck for this phone (any site)
    const today = new Date().toISOString().slice(0,10);
    const t = db.prepare("SELECT * FROM trucks WHERE phone=? AND checkin_date=? ORDER BY id DESC LIMIT 1").get(from, today);

    if (!t){
      // If no record: create an EN_ROUTE record so we have a place to store state.
      // Default to first site (lowest id) unless a site code is provided like "CCR" or "CIF" in text.
      const siteHint = (U.includes(' CCR') || U.startsWith('CCR')) ? 'CCR' : (U.includes(' CIF') || U.startsWith('CIF')) ? 'CIF' : null;
      const siteRow = siteHint ? db.prepare("SELECT id FROM sites WHERE code=?").get(siteHint) : db.prepare("SELECT id FROM sites ORDER BY id ASC LIMIT 1").get();
      if (!siteRow){ res.type('text/xml').send('<Response><Message>No sites configured</Message></Response>'); return; }
      const lineType = (U.includes('DELIVER')||U.includes('UNLOAD')) ? 'DELIVER' : 'LOAD';
      const ins = db.prepare("INSERT INTO trucks (phone,status,site_id,checkin_date,line_type) VALUES (?,?,?,?,?)").run(from,'EN_ROUTE',siteRow.id,today,lineType);
      const id = ins.lastInsertRowid || null;
      if (id) db.prepare('UPDATE trucks SET queue_seq=id WHERE id=?').run(id);
    }

    const truck = db.prepare("SELECT * FROM trucks WHERE phone=? AND checkin_date=? ORDER BY id DESC LIMIT 1").get(from, today);

    let reply = 'OK';
    const nowCol = "CURRENT_TIMESTAMP";

    if (cmd === 'ARRIVED'){
      db.prepare(`UPDATE trucks SET status='ARRIVED', arrived_at=${nowCol} WHERE id=?`).run(truck.id);
      reply = 'Thanks — marked ARRIVED. Reply LOADING when you start.';
    } else if (cmd === 'LOADING' || cmd === 'UNLOADING'){
      db.prepare(`UPDATE trucks SET status='LOADING', loading_at=${nowCol} WHERE id=?`).run(truck.id);
      reply = 'Got it — marked ' + ((truck.line_type==='DELIVER')?'UNLOADING':'LOADING') + '. Reply DEPARTED when finished.';
    } else if (cmd === 'DEPARTED' || cmd === 'CANCEL' || cmd === 'CANCELED' || cmd === 'CANCELLED'){
      db.prepare(`UPDATE trucks SET status='DEPARTED', departed_at=${nowCol} WHERE id=?`).run(truck.id);
      reply = (cmd==='DEPARTED') ? 'Marked DEPARTED. Thank you.' : 'Canceled — marked DEPARTED. Thank you.';
    } else if (cmd === 'ETA' && mEta){
      const minutes = Number(mEta[1]);
      if (minutes > 0){
        db.prepare("UPDATE trucks SET status='EN_ROUTE', enroute_at=CURRENT_TIMESTAMP, eta_minutes=?, eta_at=datetime('now','+'||?||' minutes') WHERE id=?").run(minutes, minutes, truck.id);
        reply = `ETA updated: ${minutes} min. Reply ARRIVED when you get there.`;
      } else {
        reply = 'Please send ETA as: ETA 25';
      }
    } else if (cmd === 'HELP'){
      reply = 'Commands: ARRIVED, LOADING, DEPARTED, ETA 25, CANCEL. You can also include site code: CIF or CCR.';
    } else {
      reply = 'Sorry, not sure. Try: ARRIVED, LOADING, DEPARTED, ETA 25, or CANCEL.';
    }

    res.set('Content-Type','text/xml').send(`<Response><Message>${reply}</Message></Response>`);
  }catch(e){
    console.error('Twilio inbound error', e);
    res.set('Content-Type','text/xml').send('<Response><Message>Error</Message></Response>');
  }
});


// Combined public dashboard: both LOAD and DELIVER
app.get('/api/public/:site/lines', (req,res)=>{
  const site=String(req.params.site||'').toUpperCase();
  const r=db.prepare('SELECT id FROM sites WHERE code=?').get(site);
  if (!r) return res.status(404).json({ error:'unknown site' });
  const site_id=r.id;
  const today=new Date().toISOString().slice(0,10);

  function lineBundle(type){
    const queued = db.prepare(`SELECT id, phone, product, load_number, bill_of_lading, arrived_at, created_at
                               FROM trucks
                               WHERE site_id=? AND checkin_date=? AND line_type=? AND status IN ('QUEUED','ARRIVED','LOADING')
                               ORDER BY COALESCE(arrived_at, created_at) ASC`).all(site_id, today, type)
                     .map(t=>({ id:t.id, phone: t.phone? (t.phone.slice(0,3)+'***'+t.phone.slice(-2)) : null,
                                product:t.product, load_number:t.load_number, bol:t.bill_of_lading,
                                arrived_at:t.arrived_at, created_at:t.created_at }));
    const en_route_count = db.prepare("SELECT COUNT(*) AS c FROM trucks WHERE site_id=? AND checkin_date=? AND line_type=? AND status='EN_ROUTE'").get(site_id, today, type).c;
    const en_route_eta = db.prepare("SELECT id, phone, eta_minutes, eta_at FROM trucks WHERE site_id=? AND checkin_date=? AND line_type=? AND status='EN_ROUTE' ORDER BY eta_at ASC").all(site_id, today, type)
                           .map(t=>({ id:t.id, phone: t.phone? (t.phone.slice(0,3)+'***'+t.phone.slice(-2)) : null, eta_minutes:t.eta_minutes, eta_at:t.eta_at }));
    return { queued, en_route_count, en_route_eta };
  }

  const load = lineBundle('LOAD');
  const deliver = lineBundle('DELIVER');
  const total_en_route = (load.en_route_count||0) + (deliver.en_route_count||0);
  res.json({ ok:true, site, lines: { load, deliver }, total_en_route });
});


// ---- Auto-sync: Cargill Cedar Rapids (CCR) delivery hours ----
import fs from 'fs';
import path from 'path';
const CARGILL_CEDAR_URL = process.env.CARGILL_CEDAR_URL || 'https://www.cargillag.com/locations/cedar-rapids-east-gos';
const HOURS_JSON_PATH = path.join(__dirname, '..', 'public', 'hours.json');
async function fetchText(url){ const res=await fetch(url,{headers:{'User-Agent':'VirtualLine/1.0'}}); if(!res.ok) throw new Error('Fetch failed '+res.status); return await res.text(); }
function parseCargillHours(html){
  const text = html.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li|h\d)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n+/g,'\n').trim();
  const weekOfMatch=text.match(/Week of\s+([A-Za-z0-9\/\- ,]+)/i); const week_of=weekOfMatch?weekOfMatch[1].trim():null;
  const days=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']; const schedule=[];
  for(const d of days){ const re=new RegExp(d+String.raw`\s*[:\-]?\s*([0-9]{1,2}(:[0-9]{2})?\s*(?:AM|PM|am|pm)?|TBD)[\s\-–toTO]+([0-9]{1,2}(:[0-9]{2})?\s*(?:AM|PM|am|pm)?|TBD)`,'i'); let m=text.match(re);
    if(!m){ m=text.match(new RegExp(d+String.raw`.*?(\d{1,2}:?\d{0,2}\s*(?:AM|PM|am|pm|)|TBD)\s*[\-–toTO]+\s*(\d{1,2}:?\d{0,2}\s*(?:AM|PM|am|pm|)|TBD)`,'i')); if(m){ schedule.push({day:d,hours:`${m[1].toUpperCase()} – ${m[2].toUpperCase()}`.replace(/\s+/g,' ')}); continue;} schedule.push({day:d,hours:'TBD – TBD'}); continue; }
    const open=m[1].toUpperCase(); const close=m[3].toUpperCase(); schedule.push({day:d,hours:`${open} – ${close}`.replace(/\s+/g,' ')});
  }
  return { week_of, schedule };
}
function loadHoursJSON(){ try{return JSON.parse(fs.readFileSync(HOURS_JSON_PATH,'utf8'));}catch{return{sites:{}};} }
function saveHoursJSON(obj){ fs.writeFileSync(HOURS_JSON_PATH, JSON.stringify(obj,null,2)); }
export async function syncCedarHours(){
  try{ const html=await fetchText(CARGILL_CEDAR_URL); const parsed=parseCargillHours(html);
    const data=loadHoursJSON(); data.sites=data.sites||{}; data.sites.CCR=data.sites.CCR||{name:'Cargill Cedar Rapids',lines:{}};
    const dest=data.sites.CCR; dest.lines=dest.lines||{}; dest.lines.DELIVER=dest.lines.DELIVER||{label:'Deliveries'};
    dest.lines.DELIVER.label='Deliveries'; dest.lines.DELIVER.week_of=parsed.week_of||dest.lines.DELIVER.week_of||null; dest.lines.DELIVER.schedule=parsed.schedule||dest.lines.DELIVER.schedule||[]; dest.lines.DELIVER.notes=dest.lines.DELIVER.notes||['Hours may change; check CargillAg.com'];
    saveHoursJSON(data); return { ok:true, week_of: dest.lines.DELIVER.week_of, count: dest.lines.DELIVER.schedule?.length||0 };
  }catch(e){ console.error('syncCedarHours error', e); return { ok:false, error:String(e) }; }
}
app.post('/api/admin/hours/sync', requireAuth, requireAdmin, async (req,res)=>{ const out=await syncCedarHours(); res.json(out); });
setInterval(()=>{ syncCedarHours(); }, 6*60*60*1000);
