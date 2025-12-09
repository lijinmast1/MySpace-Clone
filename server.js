require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const http = require('http');
const WebSocket = require('ws');
const uuid = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
const sessionParser = session({
	secret: process.env.SESSION_SECRET || 'dev-secret',
	resave: false,
	saveUninitialized: false
});
app.use(sessionParser);

// Static
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// File uploads
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

const bcrypt = require('bcrypt');
async function createUser(username, password) {
	const hash = await bcrypt.hash(password, 10);
	const res = await db.query(
		'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
		[username, hash]
		);
	return res.rows[0];
}

// Middleware for API
function requireAuth(req, res, next) {
	if (req.session && req.session.userId) return next();
	res.status(401).json({ error: 'unauthenticated' });
}

// Register
app.post('/api/register', async (req, res) => {
	const { username, password } = req.body;
	if (!username || !password) return res.status(400).json({ error: 'missing fields' });
	try {
		const user = await createUser(username, password);
		req.session.userId = user.id;
		req.session.username = user.username;
		res.json({ ok: true, user });
	} catch (err) {
		if (err.code === '23505') return res.status(400).json({ error: 'username taken' });
		console.error(err);
		res.status(500).json({ error: 'server error' });
	}
});

// Login
app.post('/api/login', async (req, res) => {
	const { username, password } = req.body;
	const r = await db.query('SELECT id, password_hash FROM users WHERE username=$1', [username]);
	if (!r.rows.length) return res.status(400).json({ error: 'invalid' });
	const user = r.rows[0];
	const ok = await bcrypt.compare(password, user.password_hash);
	if (!ok) return res.status(400).json({ error: 'invalid' });
	req.session.userId = user.id;
	req.session.username = username;
	res.json({ ok: true, user: { id: user.id, username } });
});

// Logout
app.post('/api/logout', (req, res) => {
	req.session.destroy(err => {
		res.json({ ok: true });
	});
});

// Update DM privacy preference
app.post("/api/settings/dm_follow_only", requireAuth, async (req, res) => {
	const me = req.session.userId;
	const { enabled } = req.body;

	try {
// Try updating first
		await db.query(`UPDATE users SET dm_follow_only=$1 WHERE id=$2`, [enabled, me]);
		return res.json({ ok: true });
	} catch (err) {
// If column is missing (Postgres undefined_column = '42703') attempt to add it and retry.
		if (err && err.code === '42703') {
			console.warn("dm_follow_only column missing - creating it now.");
			try {
				await db.query(`ALTER TABLE users ADD COLUMN dm_follow_only BOOLEAN DEFAULT false`);
				await db.query(`UPDATE users SET dm_follow_only=$1 WHERE id=$2`, [enabled, me]);
				return res.json({ ok: true });
			} catch (e2) {
				console.error("Failed to add dm_follow_only column:", e2);
				return res.status(500).json({ ok: false, error: "db migration failed" });
			}
		}
		console.error("Error updating dm_follow_only:", err);
		return res.status(500).json({ ok: false, error: "server error" });
	}
});

// Save all attachments + broadcast
app.post('/api/posts', requireAuth, upload.array('attachments', 20), async (req, res) => {
	try {
		const userId = req.session.userId;
		const { content } = req.body;

// Insert post
		const result = await db.query(
			'INSERT INTO posts (author_id, content) VALUES ($1,$2) RETURNING id, created_at',
			[userId, content]
			);
		const postId = result.rows[0].id;

// Save each uploaded file into attachments table
		for (const file of req.files || []) {
			await db.query(
				`INSERT INTO attachments (post_id, filename, original_name, mime_type, path)
				VALUES ($1,$2,$3,$4,$5)`,
				[postId, file.filename, file.originalname, file.mimetype, file.path]
				);
		}

// WebSocket broadcast
		for (const [uid, socket] of clients) {
			try {
				if (socket && socket.readyState === 1) {
					socket.send(JSON.stringify({ type: "feed_update" }));
				}
			} catch (err) { }
		}

		res.json({ ok: true, postId });
	} catch (err) {
		console.error("POST /api/posts error:", err);
		res.status(500).json({ ok: false, error: "server error" });
	}
});

// Likes (create / remove)
app.post('/api/posts/:id/like', requireAuth, async (req, res) => {
	const userId = req.session.userId;
	const postId = req.params.id;
	await db.query(
		'INSERT INTO likes (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
		[userId, postId]
		);
	const cnt = await db.query('SELECT COUNT(*) FROM likes WHERE post_id=$1', [postId]);
	res.json({ ok: true, count: parseInt(cnt.rows[0].count, 10) });
});

app.delete('/api/posts/:id/like', requireAuth, async (req, res) => {
	const userId = req.session.userId;
	const postId = req.params.id;
	await db.query('DELETE FROM likes WHERE user_id=$1 AND post_id=$2', [userId, postId]);
	const cnt = await db.query('SELECT COUNT(*) FROM likes WHERE post_id=$1', [postId]);
	res.json({ ok: true, count: parseInt(cnt.rows[0].count, 10) });
});

// Bookmarks (create / remove)
app.post('/api/posts/:id/bookmark', requireAuth, async (req, res) => {
	const userId = req.session.userId;
	const postId = req.params.id;
	await db.query(
		'INSERT INTO bookmarks (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
		[userId, postId]
		);
	const cnt = await db.query('SELECT COUNT(*) FROM bookmarks WHERE post_id=$1', [postId]);
	res.json({ ok: true, count: parseInt(cnt.rows[0].count, 10) });
});

app.delete('/api/posts/:id/bookmark', requireAuth, async (req, res) => {
	const userId = req.session.userId;
	const postId = req.params.id;
	await db.query('DELETE FROM bookmarks WHERE user_id=$1 AND post_id=$2', [userId, postId]);
	const cnt = await db.query('SELECT COUNT(*) FROM bookmarks WHERE post_id=$1', [postId]);
	res.json({ ok: true, count: parseInt(cnt.rows[0].count, 10) });
});


// Follow / unfollow
app.post('/api/users/:id/follow', requireAuth, async (req, res) => {
	const me = req.session.userId;
	const them = req.params.id;
	await db.query('INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [me, them]);
	res.json({ ok: true });
});
app.post('/api/users/:id/unfollow', requireAuth, async (req, res) => {
	const me = req.session.userId;
	const them = req.params.id;
	await db.query('DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2', [me, them]);
	res.json({ ok: true });
});

// Search users
app.get('/api/search/users', requireAuth, async (req, res) => {
	const q = (req.query.q || '').toLowerCase();
	const r = await db.query('SELECT id, username FROM users WHERE LOWER(username) LIKE $1 LIMIT 20', [q + '%']);
	res.json({ results: r.rows });
});

// Feed (posts by people you follow + your own), paginated
app.get('/api/feed', requireAuth, async (req, res) => {
	const me = req.session.userId;

	const f = await db.query(`
SELECT 
p.id,
u.username,
p.content,
p.created_at,
COALESCE(lc.like_count,0) AS like_count,
COALESCE(bc.bookmark_count,0) AS bookmark_count,
CASE WHEN ul.user_id IS NULL THEN false ELSE true END AS liked_by_me,
CASE WHEN ub.user_id IS NULL THEN false ELSE true END AS bookmarked_by_me,
COALESCE(
json_agg(
json_build_object('filename',a.filename,'original',a.original_name,'mime',a.mime_type)
) FILTER (WHERE a.id IS NOT NULL),
'[]') AS attachments
FROM posts p
JOIN users u ON u.id=p.author_id
LEFT JOIN attachments a ON a.post_id=p.id
LEFT JOIN (SELECT post_id,COUNT(*) AS like_count FROM likes GROUP BY post_id) lc ON lc.post_id=p.id
LEFT JOIN (SELECT post_id,COUNT(*) AS bookmark_count FROM bookmarks GROUP BY post_id) bc ON bc.post_id=p.id
LEFT JOIN likes ul ON ul.post_id=p.id AND ul.user_id=$1
LEFT JOIN bookmarks ub ON ub.post_id=p.id AND ub.user_id=$1
WHERE p.author_id=$1
OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id=$1)
GROUP BY p.id,u.username,p.content,p.created_at,lc.like_count,bc.bookmark_count,ul.user_id,ub.user_id
ORDER BY p.created_at DESC;
	`,[me]);

	res.json({
		posts: f.rows.map(p => ({
			id:p.id,
			username:p.username,
			created_at:p.created_at,
			liked_by_me:p.liked_by_me,
			bookmarked_by_me:p.bookmarked_by_me,
			like_count:p.like_count,
			bookmark_count:p.bookmark_count,
			attachments:p.attachments,
			content: renderPostWithAttachments(p.content, p.attachments)
		}))
	});
});

// Delete account
app.delete('/api/account', requireAuth, async (req, res) => {
	const me = req.session.userId;
	await db.query('DELETE FROM users WHERE id=$1', [me]);
	req.session.destroy(() => {});
	res.json({ ok: true });
});

// Serve index
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Safe /api/me that tolerates missing dm_follow_only column
app.get("/api/me", async (req, res) => {
	if (!req.session?.userId) return res.json({ loggedIn: false });

	try {
		const q = await db.query(`SELECT dm_follow_only FROM users WHERE id=$1`, [req.session.userId]);
		const dm_follow_only = q.rows[0] ? !!q.rows[0].dm_follow_only : false;
		res.json({
			loggedIn: true,
			user: {
				id: req.session.userId,
				username: req.session.username,
				dm_follow_only
			}
		});
	} catch (err) {
// If the column doesn't exist (undefined_column), don't crash, return defaults.
		console.warn("/api/me: db read error (falling back to defaults):", err && err.code);
		res.json({
			loggedIn: true,
			user: {
				id: req.session.userId,
				username: req.session.username,
				dm_follow_only: false
			}
		});
	}
});

// Get conversation list for sidebar
app.get("/api/conversations", requireAuth, async (req,res)=>{
	const me = req.session.userId;
	const q = await db.query(`
SELECT u.id, u.username,
( SELECT text FROM messages 
WHERE (from_user_id=u.id AND to_user_id=$1)
OR (from_user_id=$1 AND to_user_id=u.id)
ORDER BY created_at DESC LIMIT 1
) as last_msg
FROM users u
WHERE u.id IN (
SELECT DISTINCT LEAST(from_user_id,to_user_id) FROM messages WHERE from_user_id=$1 OR to_user_id=$1
UNION
SELECT DISTINCT GREATEST(from_user_id,to_user_id) FROM messages WHERE from_user_id=$1 OR to_user_id=$1
)
AND u.id <> $1
	`,[me]);

	res.json({convos:q.rows});
});

const clients = new Map();

// Follow sends refresh
app.post('/api/users/:id/follow', requireAuth, async (req,res)=>{
	await db.query('INSERT INTO follows(follower_id,followee_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
		[req.session.userId, req.params.id]);

	if(clients.get(req.session.userId))
		clients.get(req.session.userId).send(JSON.stringify({type:"feed_update"}));

	res.json({ok:true});
});


// Unfollow also refreshes
app.post('/api/users/:id/unfollow', requireAuth, async (req,res)=>{
	await db.query('DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2',
		[req.session.userId, req.params.id]);

	if(clients.get(req.session.userId))
		clients.get(req.session.userId).send(JSON.stringify({type:"feed_update"}));

	res.json({ok:true});
});

// WebSocket auth using shared express-session
wss.on("connection", (ws, req) => {

	sessionParser(req, {}, async () => {
if (!req.session?.userId) return ws.close(); // reject guests

ws.userId = req.session.userId;
clients.set(ws.userId, ws);

ws.send(JSON.stringify({ type: "ws_ready", userId: ws.userId }));

ws.on("message", async(raw)=>{
	const msg = JSON.parse(raw);

	if (msg.type === "dm") {

// Fetch recipient's DM-setting + follow state
		const q = await db.query(`
SELECT 
u.dm_follow_only,
(SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=u.id) AS i_follow_them,
(SELECT 1 FROM follows WHERE follower_id=u.id AND followee_id=$1) AS they_follow_me
FROM users u
WHERE u.id=$2
		`, [ws.userId, msg.toUserId]);

		const pref = q.rows[0];

// If recipient allows only-followers AND sender is NOT followed -> block message
		if (pref.dm_follow_only && !pref.they_follow_me) {
			ws.send(JSON.stringify({ type: "dm_blocked" }));
return; // do NOT save, do NOT forward
}

// Proceed normally
const id = uuid.v4();
await db.query(`
INSERT INTO messages(id, from_user_id, to_user_id, text)
VALUES($1,$2,$3,$4)
`,[ id, ws.userId, msg.toUserId, msg.text ]);

if (clients.get(msg.toUserId)) {
	clients.get(msg.toUserId).send(JSON.stringify({
		type:"dm", from:ws.userId, text:msg.text
	}));
	clients.get(msg.toUserId).send(JSON.stringify({type:"new_message"}));
}

ws.send(JSON.stringify({type:"dm_self", text:msg.text}));
ws.send(JSON.stringify({type:"new_message"}));
}

if (msg.type === "history"){
	const history = await db.query(`
SELECT * FROM messages
WHERE (from_user_id=$1 AND to_user_id=$2)
OR    (from_user_id=$2 AND to_user_id=$1)
ORDER BY created_at ASC
	`,[ ws.userId, msg.withUser ]);

	ws.send(JSON.stringify({type:"history", messages:history.rows}));
}
});

ws.on("close",()=> clients.delete(ws.userId));
});
});

// Check if I am ALLOWED to DM user
app.get("/api/users/:id/canDM", requireAuth, async (req,res)=>{
	const me = req.session.userId;
	const them = req.params.id;

	const q = await db.query(`
SELECT 
dm_follow_only,
(SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2) AS they_follow_me
FROM users
WHERE id=$2
	`, [me, them]);

	if (!q.rows.length)
		return res.json({ allowed:false });

	const r = q.rows[0];

// If they require follow AND they do NOT follow me -> cannot DM
	if (r.dm_follow_only && !r.they_follow_me)
		return res.json({ allowed:false });

	res.json({ allowed:true });
});

// --- Inline image embedding that maps ORIGINAL -> STORED filenames ---
function renderPostWithAttachments(content, attachments) {
	if (!content) return "";

// Build { "original.jpg": "stored_randomname.jpg" }
	const nameMap = {};
	(attachments || []).forEach(a => {
		if (a.original && a.filename) {
			nameMap[a.original] = a.filename;
		}
	});

// Replace embeds, then preserve newlines
	let html = content.replace(/\[img:([^\]]+)\]/g, (match, originalName) => {
		const stored = nameMap[originalName];
		if (!stored) {
			return `<em>[missing image: ${originalName}]</em>`;
		}
		return `<img src="/uploads/${stored}" style="max-width:100%; max-height:100vh; object-fit:contain; border-radius:6px; margin-top:6px;">`;
	});

// Convert newlines -> <br>
	html = html.replace(/\n/g, "<br>");

	return html;

}

function renderPost(content){
	return content.replace(/\[img:([^\]]+)\]/g, (m, file)=>
`<img src="/uploads/${file}" style="max-width:100%;border-radius:6px;margin-top:6px">`
);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log("🚀 Server running on http://localhost:" + PORT);
});
