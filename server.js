import express from "express";
import { createServer as createHttpsServer } from "https";
import { createServer as createHttpServer } from "http";
import { readFileSync, existsSync } from "fs";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

let server;

if (isProduction) {
  // In production (App Runner), SSL is terminated at the load balancer.
  // The container receives plain HTTP.
  console.log("Starting in PRODUCTION mode (HTTP)");
  server = createHttpServer(app);
} else {
  // In development (Localhost), we need self-signed certs for WebRTC.
  console.log("Starting in DEVELOPMENT mode (HTTPS)");

  if (existsSync("key.pem") && existsSync("cert.pem")) {
    const options = {
      key: readFileSync("key.pem"),
      cert: readFileSync("cert.pem"),
    };
    server = createHttpsServer(options, app);
  } else {
    console.warn("Warning: SSL certificates not found. WebRTC might not work locally.");
    console.warn("Falling back to HTTP for local dev.");
    server = createHttpServer(app);
  }
}

const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("."));

app.get("/connect", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/api/get-turn-credentials", (req, res) => {
  // Default to Google's public STUN server
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" }
  ];

  // If TURN credentials are provided in env vars, add them
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
    let turnUrl = process.env.TURN_URL;
    if (!turnUrl.startsWith("turn:") && !turnUrl.startsWith("turns:")) {
      turnUrl = "turn:" + turnUrl;
    }
    iceServers.push({
      urls: turnUrl,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_PASSWORD
    });
  }

  res.json({ iceServers });
});

// Session Store
// Key: Token (String)
// Value: { host: socketId, guest: socketId }
const sessions = new Map();

function generateToken() {
  return Math.floor(1000 + Math.random() * 9000).toString(); // 4 digit token
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // 1. Create Session (Host)
  socket.on("create-session", () => {
    const token = generateToken();
    sessions.set(token, { host: socket.id, guest: null });
    socket.emit("session-created", token);
    console.log(`Session created: ${token} by ${socket.id}`);
  });

  // 2. Join Session (Guest)
  socket.on("join-session", (token) => {
    const session = sessions.get(token);
    if (session) {
      if (session.guest) {
        // Optimization: Kick old guest (e.g. handling page refresh race condition)
        io.to(session.guest).emit("error", "Another device connected. You have been disconnected.");
        // We don't return here; we overwrite session.guest
        console.log(`Session ${token} guest overridden: ${session.guest} -> ${socket.id}`);
      }
      session.guest = socket.id;

      // Notify Guest they joined
      socket.emit("session-joined", { role: "guest", peerId: session.host });

      // Notify Host that Guest joined
      io.to(session.host).emit("peer-joined", { role: "host", peerId: socket.id });

      console.log(`User ${socket.id} joined session ${token}`);
    } else {
      socket.emit("error", "Invalid Token");
    }
  });

  // --- Signaling (Forwarding) ---
  socket.on("offer", (payload) => {
    // payload: { target, sdp }
    io.to(payload.target).emit("offer", {
      sdp: payload.sdp,
      caller: socket.id,
    });
  });

  socket.on("answer", (payload) => {
    io.to(payload.target).emit("answer", {
      sdp: payload.sdp,
      responder: socket.id,
    });
  });

  socket.on("ice-candidate", (payload) => {
    io.to(payload.target).emit("ice-candidate", {
      candidate: payload.candidate,
      sender: socket.id,
    });
  });

  socket.on("hangup", (payload) => {
    if (payload.target) {
      io.to(payload.target).emit("hangup", { sender: socket.id });
    }
  });

  socket.on("open-door", (payload) => {
    if (payload.target) {
      io.to(payload.target).emit("open-door", { sender: socket.id });
    }
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    for (const [token, session] of sessions.entries()) {
      if (session.host === socket.id) {
        // Host left -> Destroy Session
        if (session.guest) {
          io.to(session.guest).emit("error", "Host disconnected");
          io.to(session.guest).emit("peer-disconnected");
        }
        sessions.delete(token);
        console.log(`Session ${token} destroyed (Host left)`);
      } else if (session.guest === socket.id) {
        // Guest left -> Clear Guest slot, Notify Host
        session.guest = null;
        io.to(session.host).emit("peer-disconnected");
        console.log(`Session ${token} guest left`);
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const protocol = isProduction ? "http" : "https";
  console.log(`Server running on ${protocol}://0.0.0.0:${PORT}`);
});
