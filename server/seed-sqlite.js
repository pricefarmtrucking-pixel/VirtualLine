import Database from 'better-sqlite3';

const db = new Database('data.db');
const SITE_ID = 100; const SITE2_ID = 101;
const SITE_CODE = 'CIF'; const SITE2_CODE='CCR';
const SITE_NAME = 'Cargill Iowa Falls'; const SITE2_NAME='Cargill Cedar Rapids';

function run(){
  db.prepare('INSERT OR IGNORE INTO sites (id, code, name) VALUES (?,?,?)').run(SITE_ID, SITE_CODE, SITE_NAME);
  db.prepare('INSERT OR IGNORE INTO sites (id, code, name) VALUES (?,?,?)').run(SITE2_ID, SITE2_CODE, SITE2_NAME);
  const today = new Date().toISOString().slice(0,10); const today2=today;
  db.prepare(`INSERT OR IGNORE INTO site_settings (site_id, date, loads_target, open_time, close_time, workins_per_hour, paused)
              VALUES (?,?,?,?,?,?,?)`).run(SITE_ID, today, 120, '07:00', '17:00', 2, 0);
  const adminPhone = process.env.ADMIN_PHONE && String(process.env.ADMIN_PHONE).trim();
  if (adminPhone){
    db.prepare('INSERT OR IGNORE INTO users (phone) VALUES (?)').run(adminPhone);
    db.prepare('INSERT OR IGNORE INTO app_admins (phone) VALUES (?)').run(adminPhone);
    console.log('Seeded admin', adminPhone);
  } else {
    console.log('No ADMIN_PHONE provided; skipping admin seed');
  }
  console.log('SQLite seed done.');
}
run();

  // seed second site settings
  db.prepare(`INSERT OR IGNORE INTO site_settings (site_id, date, loads_target, open_time, close_time, workins_per_hour, paused)
              VALUES (?,?,?,?,?,?,?)`).run(SITE2_ID, today2, 120, '07:00', '17:00', 2, 0);
