import pg from 'pg';

const SITE_ID = 100; const SITE2_ID = 101;
const SITE_CODE = 'CIF'; const SITE2_CODE='CCR';
const SITE_NAME = 'Cargill Iowa Falls'; const SITE2_NAME='Cargill Cedar Rapids';

async function run(){
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try{
    await client.query('INSERT INTO sites (id, code, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [SITE_ID, SITE_CODE, SITE_NAME]);
    await client.query('INSERT INTO sites (id, code, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [SITE2_ID, SITE2_CODE, SITE2_NAME]);
    await client.query('INSERT INTO sites (id, code, name) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING', [SITE_ID, SITE_CODE, SITE_NAME]);
    await client.query('INSERT INTO sites (id, code, name) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING', [SITE2_ID, SITE2_CODE, SITE2_NAME]);
    const today = new Date().toISOString().slice(0,10); const today2=today;
    await client.query(
      `INSERT INTO site_settings (site_id, date, loads_target, open_time, close_time, workins_per_hour, paused)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [SITE_ID, today, 120, '07:00', '17:00', 2, 0]
    );

    await client.query(
      `INSERT INTO site_settings (site_id, date, loads_target, open_time, close_time, workins_per_hour, paused)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [SITE2_ID, today2, 120, '07:00', '17:00', 2, 0]
    );
    const adminPhone = process.env.ADMIN_PHONE && String(process.env.ADMIN_PHONE).trim();
    if (adminPhone){
      await client.query('INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING', [adminPhone]);
      await client.query('INSERT INTO app_admins (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING', [adminPhone]);
      console.log('Seeded admin', adminPhone);
    } else {
      console.log('No ADMIN_PHONE provided; skipping admin seed');
    }
    console.log('PG seed done.');
  } finally {
    client.release();
    await pool.end();
  }
}
run().catch(e=>{ console.error(e); process.exit(1); });
