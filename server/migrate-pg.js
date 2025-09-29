import fs from 'fs';
import pg from 'pg';

const sql = fs.readFileSync(new URL('./schema.pg.sql', import.meta.url), 'utf8');

async function run(){
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try{
    // Split on semicolons not within strings (simple split ok for our schema)
    const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
    for (const stmt of statements){
      await client.query(stmt);
    }
    console.log('Postgres migrations applied.');
  } finally {
    client.release();
    await pool.end();
  }
}
run().catch(err=>{ console.error(err); process.exit(1); });
