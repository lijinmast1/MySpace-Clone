// creates tables and seeds sample data
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await db.query(sql);
    console.log('Schema created.');

    // Insert sample users and posts
    await db.query("INSERT INTO users (username, password_hash) VALUES ('alice', '$2b$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') ON CONFLICT DO NOTHING");
    await db.query("INSERT INTO users (username, password_hash) VALUES ('bob', '$2b$10$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') ON CONFLICT DO NOTHING");
    console.log('Sample users added (passwords are dummy; use register to create real accounts).');
  } catch (err) {
    console.error(err);
  } finally {
    db.end();
  }
})();
