import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const dbPath =
  process.env.NODE_ENV === "production" ? "/app/data/tasks.db" : "tasks.db";

// Ensure directory exists for production
if (process.env.NODE_ENV === "production") {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const db = new Database(dbPath);

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    name TEXT,
    avatar_url TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT DEFAULT 'medium', -- low, medium, high
    category TEXT DEFAULT 'General',
    due_date TEXT,
    completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS subtasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    title TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
`);

const app = express();
const PORT = 3002;
const JWT_SECRET = process.env.JWT_SECRET || "default_secret";

app.use(express.json());
app.use(cookieParser());

// Auth Middleware
const authenticate = (req: any, res: any, next: any) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

// Auth Routes
app.post("/api/register", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const stmt = db.prepare(
      "INSERT INTO users (email, password, name) VALUES (?, ?, ?)"
    );
    const result = stmt.run(email, hashedPassword, name || email.split("@")[0]);
    res.json({ id: result.lastInsertRowid });
  } catch (err: any) {
    if (err.message.includes("UNIQUE constraint failed")) {
      res.status(400).json({ error: "Email already exists" });
    } else {
      res.status(500).json({ error: "Registration failed" });
    }
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user: any = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email);

  if (user && (await bcrypt.compare(password, user.password))) {
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "24h" }
    );
    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });
    res.json({ id: user.id, email: user.email, name: user.name });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

app.get("/api/me", authenticate, (req: any, res) => {
  res.json(req.user);
});

// Stats Route
app.get("/api/stats", authenticate, (req: any, res) => {
  const stats = db
    .prepare(
      `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN priority = 'high' AND completed = 0 THEN 1 ELSE 0 END) as high_priority_pending
    FROM tasks 
    WHERE user_id = ?
  `
    )
    .get(req.user.id);

  const weekly = db
    .prepare(
      `
    SELECT date(created_at) as date, COUNT(*) as count
    FROM tasks
    WHERE user_id = ? AND created_at >= date('now', '-7 days')
    GROUP BY date(created_at)
  `
    )
    .all(req.user.id);

  res.json({ ...stats, weekly });
});

// Task Routes
app.get("/api/tasks", authenticate, (req: any, res) => {
  const tasks = db
    .prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.user.id);
  // Fetch subtasks for each task
  const tasksWithSubtasks = tasks.map((task: any) => {
    const subtasks = db
      .prepare("SELECT * FROM subtasks WHERE task_id = ?")
      .all(task.id);
    return { ...task, subtasks };
  });
  res.json(tasksWithSubtasks);
});

app.post("/api/tasks", authenticate, (req: any, res) => {
  const { title, description, priority, category, due_date } = req.body;
  const stmt = db.prepare(`
    INSERT INTO tasks (user_id, title, description, priority, category, due_date) 
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    req.user.id,
    title,
    description,
    priority || "medium",
    category || "General",
    due_date
  );
  res.json({ id: result.lastInsertRowid, title, completed: 0, subtasks: [] });
});

app.put("/api/tasks/:id", authenticate, (req: any, res) => {
  const { title, description, priority, category, due_date, completed } =
    req.body;

  console.log("edit task", req.body);

  const { id } = req.params;
  const stmt = db.prepare(`
    UPDATE tasks 
    SET title = ?, description = ?, priority = ?, category = ?, due_date = ?, completed = ? 
    WHERE id = ? AND user_id = ?
  `);
  stmt.run(
    title,
    description,
    priority,
    category,
    due_date,
    completed ? 1 : 0,
    id,
    req.user.id
  );
  res.json({ success: true });
});

app.delete("/api/tasks/:id", authenticate, (req: any, res) => {
  const { id } = req.params;
  const stmt = db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?");
  stmt.run(id, req.user.id);
  res.json({ success: true });
});

// Subtask Routes
app.post("/api/tasks/:taskId/subtasks", authenticate, (req: any, res) => {
  const { taskId } = req.params;
  const { title } = req.body;
  const stmt = db.prepare(
    "INSERT INTO subtasks (task_id, title) VALUES (?, ?)"
  );
  const result = stmt.run(taskId, title);
  res.json({ id: result.lastInsertRowid, title, completed: 0 });
});

app.put("/api/subtasks/:id", authenticate, (req: any, res) => {
  const { completed } = req.body;
  const { id } = req.params;
  const stmt = db.prepare("UPDATE subtasks SET completed = ? WHERE id = ?");
  stmt.run(completed ? 1 : 0, id);
  res.json({ success: true });
});

// Vite Middleware
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
